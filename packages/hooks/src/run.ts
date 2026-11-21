/**
 * The hook runner's core: hook stdin → (guard, gateway policy) → harness stdout. No process I/O
 * here; `main.ts` wires stdin/stdout/env. Every failure path returns empty stdout and exit 0.
 */
import {
  budgetFor,
  commandOf,
  deterministicBlock,
  guardCommand,
  isShellTool,
  MAX_COMMAND_CHARS,
  OVERSIZE_COMMAND,
  str,
  type DecideRequest,
  type DecideResponse,
  type GuardHit,
  type HookInput,
} from '@ziptie-soft/local-decider-core';

import { gatewayClient, type Env } from './gateway-config.ts';
import {
  callOf,
  EVENT_POLICY,
  isLifecycleEvent,
  mapEvent,
  parseEvent,
  parseHarness,
  type HookHarness,
  type PolicyEvent,
  type LifecycleEvent,
  type ReadTranscript,
} from './mapping.ts';
import { postToolUse, purgePending, rememberPermission, type OutcomeDeps } from './outcomes.ts';
import { guardOutput, translate } from './output.ts';
import { mayAutoAllow } from './permission-tools.ts';
import { healthFromEnv, sessionStart, type Health } from './session-start.ts';
import { agentLabel, isCompletedAgent, subagentInput } from './subagent.ts';
import { readSlice } from './transcript.ts';
import { writeGuard } from './write-guard.ts';

export type { Env } from './gateway-config.ts';
export type Decide = (policy: string, request: DecideRequest) => Promise<DecideResponse | null>;

export interface RunDeps {
  /** Gateway call; defaults to a `GatewayClient` configured from `env`. */
  readonly decide?: Decide;
  /** Gateway health for `SessionStart`; defaults to a `GatewayClient` configured from `env`. */
  readonly health?: Health;
  readonly readTranscript?: ReadTranscript;
  /** Pending-prompt store and outcome reporting; defaults derive from `env`. */
  readonly outcomes?: OutcomeDeps;
  /** Diagnostics sink, used only when `LOCAL_DECIDER_DEBUG=1`. */
  readonly stderr?: (line: string) => void;
  /**
   * Set by `main.ts` for oversized stdin. `large` (4–32 MiB): `stdinText` is the whole payload and
   * only the deterministic guard runs. `huge` (over 32 MiB): `stdinText` is just the head, never
   * parsed, and a PreToolUse asks (Claude) or denies (Codex).
   */
  readonly oversize?: 'large' | 'huge';
}

export interface RunResult {
  readonly stdout: string;
  readonly exitCode: 0;
}

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Comma list of policies a host already runs for this session, set by the Paseo plugin on the
 * agents it launches. The hooks skip those so one event gets one decision; the guard and any
 * policy not listed still run.
 */
const HOST_POLICIES_ENV = 'LOCAL_DECIDER_HOST_POLICIES';
const NOTHING: RunResult = { stdout: '', exitCode: 0 };

export function timeoutOf(env: Env): number {
  const n = Number(env['LOCAL_DECIDER_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function clientFromEnv(env: Env): Decide {
  const client = gatewayClient(env, timeoutOf(env));
  return async (policy, request) => client.decide(policy, request);
}

function parseHook(stdinText: string): HookInput | null {
  try {
    const value: unknown = JSON.parse(stdinText);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as HookInput)
      : null;
  } catch {
    return null;
  }
}

function hostRuns(env: Env, policy: string): boolean {
  return (env[HOST_POLICIES_ENV] ?? '').split(',').some((p) => p.trim() === policy);
}

function commandHit(command: string): GuardHit | null {
  return command.length > MAX_COMMAND_CHARS ? OVERSIZE_COMMAND : guardCommand(command);
}

function shellGuard(harness: HookHarness, hook: HookInput): string {
  if (!isShellTool(hook)) {
    return '';
  }
  const command = commandOf(hook);
  const hit = command === undefined ? null : commandHit(command);
  return hit === null ? '' : guardOutput(harness, hit, hook['permission_mode'] === 'auto');
}

function writeGuardOutput(harness: HookHarness, hook: HookInput): string {
  const hit = writeGuard(str(hook['tool_name']) ?? '', hook['tool_input'], str(hook['cwd']) ?? '');
  return hit === null ? '' : guardOutput(harness, hit, hook['permission_mode'] === 'auto');
}

function guardResult(ctx: Context): string {
  return ctx.env['LOCAL_DECIDER_GUARD'] === 'off'
    ? ''
    : shellGuard(ctx.harness, ctx.hook) || writeGuardOutput(ctx.harness, ctx.hook);
}

interface Context {
  readonly harness: HookHarness;
  readonly event: PolicyEvent;
  readonly hook: HookInput;
  readonly env: Env;
  readonly deps: RunDeps;
  readonly log: (msg: string) => void;
}

function requestOf(ctx: Context, call: ReturnType<typeof mapEvent>): DecideRequest {
  const sessionId = str(ctx.hook['session_id']);
  const toolCall = callOf(ctx.harness, ctx.event, ctx.hook);
  const budget = budgetFor(timeoutOf(ctx.env));
  return {
    harness: ctx.harness === 'claude' ? 'claude-code' : 'codex',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolCall === undefined ? {} : { call: toolCall }),
    ...(call.workspace === undefined ? {} : { workspace: call.workspace }),
    ...(budget === undefined ? {} : { budgetMs: budget }),
    input: call.input,
  };
}

/** Why a model must not be asked to allow this call (outside cwd, protected, risky), or null. */
function permissionBlock(ctx: Context, tool: string | undefined): string | null {
  const cwd = str(ctx.hook['cwd']);
  if (cwd === undefined) {
    return 'no working directory';
  }
  return deterministicBlock(tool ?? '', ctx.hook['tool_input'], cwd);
}

async function decideAndTranslate(ctx: Context): Promise<string> {
  const tool = str(ctx.hook['tool_name']);
  if (ctx.event === 'PermissionRequest' && !mayAutoAllow(ctx.harness, tool)) {
    // Not a tool the hook may allow: no engine call, the harness shows its normal prompt.
    ctx.log(`permission: ${tool ?? 'unnamed tool'} is not auto-allowable; abstaining`);
    return '';
  }
  const blocked = ctx.event === 'PermissionRequest' ? permissionBlock(ctx, tool) : null;
  if (blocked !== null) {
    ctx.log(`permission: ${blocked}; abstaining`);
    return '';
  }
  const call = mapEvent(ctx.event, ctx.hook, ctx.deps.readTranscript ?? readSlice);
  if (
    ctx.event === 'PermissionRequest' &&
    (!call.hasRecentUserContext || typeof call.input['task'] !== 'string')
  ) {
    ctx.log('permission: recent user context unavailable; abstaining');
    return '';
  }
  const request = requestOf(ctx, call);
  const decide = ctx.deps.decide ?? clientFromEnv(ctx.env);
  const res = await decide(call.policy, request);
  ctx.log(
    res === null
      ? `${call.policy}: no answer (gateway down, slow or erroring); abstaining`
      : `${call.policy}: action=${res.action} enforced=${String(res.enforced)} id=${res.decisionId}`,
  );
  const autoMode = ctx.hook['permission_mode'] === 'auto';
  const subject = ctx.event === 'SubagentResult' ? agentLabel(ctx.hook) : tool;
  const stdout = translate(ctx.harness, ctx.event, res, autoMode, subject);
  if (ctx.event === 'PermissionRequest' && res !== null) {
    rememberPermission({ ...ctx, res, stdout, deps: ctx.deps.outcomes });
  }
  return stdout;
}

/** Why a SubagentResult has nothing to judge (so no gateway call), or null. */
function subagentSkip(ctx: Context): string | null {
  if (ctx.harness !== 'claude') {
    return 'only Claude Code reports subagent results';
  }
  if (!isCompletedAgent(ctx.hook)) {
    return 'not a completed foreground subagent';
  }
  return subagentInput(ctx.hook)['lastMessage'] === '' ? 'empty subagent report' : null;
}

async function handle(ctx: Context): Promise<string> {
  if (ctx.event === 'PreToolUse') {
    const denied = guardResult(ctx);
    if (denied !== '') {
      ctx.log('guard deny');
      return denied;
    }
  }
  if (ctx.event === 'Stop' && ctx.hook['stop_hook_active'] === true) {
    ctx.log('stop_hook_active: skipping');
    return '';
  }
  if (ctx.event === 'SubagentResult') {
    // No hostRuns skip: Paseo lists turn-outcome for the agents it launches, but it never sees the
    // Task subagents inside them, so nothing else judges these results.
    const skip = subagentSkip(ctx);
    if (skip !== null) {
      ctx.log(`subagent result: ${skip}; abstaining`);
      return '';
    }
    return decideAndTranslate(ctx);
  }
  const policy = EVENT_POLICY[ctx.event];
  if (hostRuns(ctx.env, policy)) {
    ctx.log(`${policy}: run by the host (${HOST_POLICIES_ENV}); skipping`);
    return '';
  }
  return decideAndTranslate(ctx);
}

interface LifecycleContext extends Omit<Context, 'event'> {
  readonly event: LifecycleEvent;
}

async function lifecycle(ctx: LifecycleContext): Promise<string> {
  const { harness, hook, env, deps, log } = ctx;
  if (ctx.event === 'PostToolUse') {
    await postToolUse(harness, hook, env, deps.outcomes, log, timeoutOf(env));
    return '';
  }
  purgePending(env, deps.outcomes, log);
  return sessionStart(harness, env, deps.health ?? healthFromEnv(env, timeoutOf(env)));
}

function logger(env: Env, deps: RunDeps): (msg: string) => void {
  if (env['LOCAL_DECIDER_DEBUG'] !== '1') {
    return () => undefined;
  }
  const sink = deps.stderr ?? ((line: string) => void process.stderr.write(line));
  return (msg) => {
    sink(`local-decider: ${msg}\n`);
  };
}

const OVERSIZE_INPUT: GuardHit = {
  rule: 'oversize-input',
  reason: 'hook input too large to check',
  ask: true,
};
const AUTO_MODE = /"permission_mode"\s*:\s*"auto"/;

/**
 * Oversized stdin: no gateway call and no model. PreToolUse still gets the guard (`large`) or an
 * ask/deny (`huge`, which is never parsed); every other event fails open.
 */
function oversizeRun(
  harnessName: string,
  eventName: string,
  stdinText: string,
  env: Env,
  tier: 'large' | 'huge',
): RunResult {
  const harness = parseHarness(harnessName);
  if (
    harness === undefined ||
    parseEvent(eventName) !== 'PreToolUse' ||
    env['LOCAL_DECIDER_GUARD'] === 'off'
  ) {
    return NOTHING;
  }
  if (tier === 'huge') {
    return { stdout: guardOutput(harness, OVERSIZE_INPUT, AUTO_MODE.test(stdinText)), exitCode: 0 };
  }
  const hook = parseHook(stdinText);
  if (hook === null) {
    return NOTHING;
  }
  const ctx = { harness, event: 'PreToolUse', hook, env, deps: {}, log: () => undefined } as const;
  return { stdout: guardResult(ctx), exitCode: 0 };
}

/** Run one hook invocation. Never throws; any failure abstains (empty stdout, exit 0). */
export async function run(
  harnessName: string,
  eventName: string,
  stdinText: string,
  env: Env,
  deps: RunDeps = {},
): Promise<RunResult> {
  const log = logger(env, deps);
  try {
    if (deps.oversize !== undefined) {
      return oversizeRun(harnessName, eventName, stdinText, env, deps.oversize);
    }
    const harness = parseHarness(harnessName);
    const event = parseEvent(eventName);
    const hook = parseHook(stdinText);
    if (harness === undefined || event === undefined || hook === null) {
      log(`ignoring ${harnessName} ${eventName} (unknown harness/event or bad stdin)`);
      return NOTHING;
    }
    if (isLifecycleEvent(event)) {
      return { stdout: await lifecycle({ harness, event, hook, env, deps, log }), exitCode: 0 };
    }
    const stdout = await handle({ harness, event, hook, env, deps, log });
    return { stdout, exitCode: 0 };
  } catch (error) {
    log(`error, failing open: ${error instanceof Error ? error.message : String(error)}`);
    return NOTHING;
  }
}
