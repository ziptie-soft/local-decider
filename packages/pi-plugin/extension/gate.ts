/**
 * The `tool_call` gate (ADR-0013, "Tool-call gate"). `handle` filters off mode and exempt tools
 * and runs the mode inside `try/catch`.
 *
 * - Guard mode keeps pi's run-by-default behaviour: only a hard guard hit or an enforced `deny`
 *   blocks, and only an enforced `ask` or a guard `ask` shows the dialog. Every gateway failure
 *   and every internal error runs the call.
 * - Approve mode runs a call without a dialog only when it clears the auto-allow bar
 *   (`mayAutoAllow`). Anything else shows the dialog, and a call that needs one but cannot get one
 *   is blocked. An internal error falls back to the dialog too, so it never runs a call the user
 *   did not see: the user chose approve mode, the ADR's one exception to failing open.
 *
 * Breaker state lives in the closure; the caller recreates the gate on a session reset.
 */
import type { Config } from './config.ts';
import { readContext, type SessionContext } from './context.ts';
import { isEnforcedAllow, type DecideReply, type DecideRequest, type Gateway } from './gateway.ts';
import { commandRiskRequest, permissionRequest } from './mapping.ts';
import type { PiContext, ToolCallEvent, ToolCallResult } from './pi-types.ts';
import { askPermission, MAX_TITLE_CHARS, sanitizeForDisplay } from './prompt.ts';
import { checkSafety, type SafetyOptions, type SafetyResult } from './safety.ts';
import { classifyTool, type ToolDescriptor } from './tools.ts';

export interface GateDeps {
  /** Read on every call: the mode may change per session. */
  readonly getConfig: () => Config;
  readonly gateway: Gateway;
  /** Breaker clock, in milliseconds. */
  readonly now: () => number;
  /** Short messages only: never tokens or full tool inputs. */
  readonly log: (message: string) => void;
  readonly platform: NodeJS.Platform;
  /** Called with each decision id the gateway returns. */
  readonly onDecision?: (decisionId: string) => void;
  /** Overrides the environment and home directory the config-protection check reads. */
  readonly safety?: SafetyOptions;
}

export type Gate = (event: ToolCallEvent, ctx: PiContext) => Promise<ToolCallResult | undefined>;

/** How long the gateway is skipped after a failure: sibling calls are preflighted one by one. */
export const BREAKER_MS = 30_000;
/** Bound on an outcome report; it never changes the call's result. */
export const REPORT_TIMEOUT_MS = 1000;
export const USER_BLOCK_REASON = 'Blocked by the user (local-decider).';
export const HEADLESS_BLOCK_REASON =
  'local-decider approve mode: this call needs approval and pi has no UI here (set --local-decider-mode guard to run headless).';
export const ERROR_BLOCK_REASON =
  'local-decider approve mode: the gate failed and could not ask for approval; blocked.';

const PREFIX = 'local-decider';
const COMMAND_RISK = 'command-risk';
const PERMISSION = 'permission';
const DETAIL_CHARS = 120;

/** One gated call, as the modes see it. */
interface GatedCall {
  readonly event: ToolCallEvent;
  readonly ctx: PiContext;
  readonly config: Config;
  readonly tool: ToolDescriptor;
}

/** What the dialog shows, and the decision its answer is reported against, if any. */
interface Prompt {
  readonly reason: string;
  readonly decisionId?: string;
}

function blocked(reason: string): ToolCallResult {
  return { block: true, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  return sanitizeForDisplay(text, DETAIL_CHARS);
}

/** ` (<question>=<answer>, confidence x.xx)` from the first answer, or '' when it is unusable. */
function answerDetail(answers: Readonly<Record<string, unknown>>): string {
  const first = Object.entries(answers)[0];
  if (first === undefined) {
    return '';
  }
  const [question, value] = first;
  if (!isRecord(value) || typeof value['answer'] !== 'string') {
    return '';
  }
  const confidence = value['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return '';
  }
  return ` (${oneLine(question)}=${oneLine(value['answer'])}, confidence ${confidence.toFixed(2)})`;
}

/** `local-decider <policy>: <action> (<q>=<a>, confidence x.xx). Decision <id>.` */
function decisionSummary(policy: string, reply: DecideReply): string {
  const action = oneLine(reply.action);
  return `${PREFIX} ${policy}: ${action}${answerDetail(reply.answers)}. Decision ${reply.decisionId}.`;
}

function denyReason(policy: string, reply: DecideReply): string {
  return `${decisionSummary(policy, reply)} Ask the user before retrying.`;
}

function guardReason(reason: string): string {
  return `${PREFIX} guard: ${oneLine(reason)}. Ask the user before retrying.`;
}

/** The action of an enforced reply; null for a shadow reply or none. */
function enforcedAction(reply: DecideReply | null): string | null {
  return reply?.enforced ? reply.action : null;
}

/**
 * Guard mode needs only the session id and cwd, so it skips `readContext`'s walk of the session
 * entries on every call. The cwd comes from the session manager, as in `readContext`.
 */
function sessionOf(ctx: PiContext): SessionContext {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.sessionManager.getCwd(),
    hasRecentUserContext: false,
  };
}

function dialogFor(tool: ToolDescriptor, reason: string): { title: string; detail: string } {
  const title = sanitizeForDisplay(`${PREFIX}: allow ${tool.name}?`, MAX_TITLE_CHARS);
  const subject = tool.command ?? tool.path;
  const detail = subject === undefined ? reason : `${subject}\n\n${reason}`;
  return { title, detail };
}

/**
 * The approve-mode auto-allow bar (as Paseo's `mayAllow` and the hooks' PermissionRequest path):
 * an enforced allow, a shell or edit tool on POSIX that passes the deterministic and config guards
 * (`autoAllow`), and a session with a task and recent user context.
 */
function mayAutoAllow(
  reply: DecideReply | null,
  safety: SafetyResult,
  session: SessionContext,
): boolean {
  return (
    isEnforcedAllow(reply) &&
    safety.autoAllow &&
    session.hasRecentUserContext &&
    session.task !== undefined
  );
}

/** Why an approve-mode call was not auto-allowed, for the dialog; null when the reply says it. */
function notAutoAllowed(safety: SafetyResult, session: SessionContext): string | null {
  if (safety.ask !== null) {
    return `${PREFIX} guard: ${oneLine(safety.ask)}.`;
  }
  if (!safety.autoAllow) {
    return 'Only checked shell and edit calls on macOS or Linux are approved automatically.';
  }
  if (!session.hasRecentUserContext || session.task === undefined) {
    return 'The session has no task or recent user message yet.';
  }
  return null;
}

function approvePrompt(
  reply: DecideReply | null,
  safety: SafetyResult,
  session: SessionContext,
): Prompt {
  const decision =
    reply === null
      ? `${PREFIX} ${PERMISSION}: no decision (gateway unavailable).`
      : `${decisionSummary(PERMISSION, reply)}${reply.enforced ? '' : ' (not enforced)'}`;
  const explain = isEnforcedAllow(reply) || safety.ask !== null;
  const why = explain ? notAutoAllowed(safety, session) : null;
  const reason = why === null ? decision : `${decision}\n${why}`;
  return reply === null ? { reason } : { reason, decisionId: reply.decisionId };
}

export function createGate(deps: GateDeps): Gate {
  const { gateway, now, log } = deps;
  let breakerOpenUntil = 0;

  function noteDecision(decisionId: string): void {
    try {
      deps.onDecision?.(decisionId);
    } catch {
      // A failing observer never changes the decision.
    }
  }

  function openBreaker(ctx: PiContext): void {
    // An aborted turn is not a gateway failure.
    if (ctx.signal?.aborted) {
      return;
    }
    breakerOpenUntil = now() + BREAKER_MS;
    log(`${PREFIX}: gateway unavailable; skipping it for ${BREAKER_MS / 1000} s`);
  }

  /** The gateway's reply, or null when it failed or the breaker is open. */
  async function decide(
    policy: string,
    request: DecideRequest,
    timeoutMs: number,
    ctx: PiContext,
  ): Promise<DecideReply | null> {
    if (now() < breakerOpenUntil) {
      return null;
    }
    let reply: DecideReply | null;
    try {
      reply = await gateway.decide(policy, request, { timeoutMs, signal: ctx.signal });
    } catch {
      reply = null;
    }
    if (reply === null) {
      openBreaker(ctx);
      return null;
    }
    noteDecision(reply.decisionId);
    return reply;
  }

  /** Report a dialog answer, bounded to `REPORT_TIMEOUT_MS`; never throws. */
  async function report(decisionId: string, outcome: 'allow' | 'decline'): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), REPORT_TIMEOUT_MS);
    });
    try {
      const sent = gateway.reportOutcome(decisionId, outcome, { timeoutMs: REPORT_TIMEOUT_MS });
      if (!(await Promise.race([sent, bound]))) {
        log(`${PREFIX}: outcome report failed`);
      }
    } catch {
      log(`${PREFIX}: outcome report failed`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Show the dialog. `allow` runs and `decline` blocks; `unavailable` (headless or a broken UI)
   * returns `onUnavailable`. The result is fixed before the report, which cannot change it.
   */
  async function confirm(
    call: GatedCall,
    prompt: Prompt,
    onUnavailable: ToolCallResult | undefined,
  ): Promise<ToolCallResult | undefined> {
    const answer = await askPermission(call.ctx, dialogFor(call.tool, prompt.reason), {
      timeoutMs: call.config.dialogTimeoutMs,
    });
    if (answer === 'unavailable') {
      return onUnavailable;
    }
    const result = answer === 'allow' ? undefined : blocked(USER_BLOCK_REASON);
    if (prompt.decisionId !== undefined) {
      await report(prompt.decisionId, answer);
    }
    return result;
  }

  async function guardMode(
    call: GatedCall,
    session: SessionContext,
    safety: SafetyResult,
  ): Promise<ToolCallResult | undefined> {
    const { event, ctx, config, tool } = call;
    const timeoutMs = config.guardTimeoutMs;
    const request = commandRiskRequest(tool, event.input, session, timeoutMs, event.toolCallId);
    const reply = await decide(COMMAND_RISK, request, timeoutMs, ctx);
    const action = enforcedAction(reply);
    if (reply !== null && action === 'deny') {
      return blocked(denyReason(COMMAND_RISK, reply));
    }
    if (reply !== null && action === 'ask') {
      const prompt = { reason: decisionSummary(COMMAND_RISK, reply), decisionId: reply.decisionId };
      return confirm(call, prompt, undefined);
    }
    if (safety.ask !== null) {
      return confirm(call, { reason: `${PREFIX} guard: ${oneLine(safety.ask)}.` }, undefined);
    }
    return undefined;
  }

  async function approveMode(
    call: GatedCall,
    session: SessionContext,
    safety: SafetyResult,
  ): Promise<ToolCallResult | undefined> {
    const { event, ctx, config, tool } = call;
    const timeoutMs = config.approveTimeoutMs;
    const request = permissionRequest(tool, event.input, session, timeoutMs, event.toolCallId);
    const reply = await decide(PERMISSION, request, timeoutMs, ctx);
    if (reply !== null && enforcedAction(reply) === 'deny') {
      return blocked(denyReason(PERMISSION, reply));
    }
    if (mayAutoAllow(reply, safety, session)) {
      return undefined;
    }
    return confirm(call, approvePrompt(reply, safety, session), blocked(HEADLESS_BLOCK_REASON));
  }

  /** Both modes: the session, the deterministic checks (a hard hit blocks), then the mode. */
  async function gated(call: GatedCall): Promise<ToolCallResult | undefined> {
    const approve = call.config.mode === 'approve';
    // Guard mode needs no task or history (see `sessionOf`); approve mode's bar does.
    const session = approve ? readContext(call.ctx) : sessionOf(call.ctx);
    const safety = checkSafety(call.tool, session.cwd, deps.platform, deps.safety);
    if (safety.hard !== null) {
      return blocked(guardReason(safety.hard));
    }
    return approve ? approveMode(call, session, safety) : guardMode(call, session, safety);
  }

  /** Approve mode after an internal error: ask the user, and block when that fails too. */
  async function approveOnError(
    event: ToolCallEvent,
    ctx: PiContext,
    config: Config,
  ): Promise<ToolCallResult | undefined> {
    try {
      const name = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const call: GatedCall = { event, ctx, config, tool: { kind: 'unknown', name } };
      const prompt = { reason: `${PREFIX}: the gate failed on this call; check it yourself.` };
      return await confirm(call, prompt, blocked(HEADLESS_BLOCK_REASON));
    } catch {
      return blocked(ERROR_BLOCK_REASON);
    }
  }

  /** Off mode, exempt tools, then the mode; errors fail open except in approve mode. */
  async function run(
    event: ToolCallEvent,
    ctx: PiContext,
    config: Config,
  ): Promise<ToolCallResult | undefined> {
    try {
      const tool = classifyTool(event.toolName, event.input);
      if (tool.kind === 'exempt') {
        return undefined;
      }
      return await gated({ event, ctx, config, tool });
    } catch {
      if (config.mode !== 'approve') {
        log(`${PREFIX}: gate error; the call runs`);
        return undefined;
      }
      log(`${PREFIX}: gate error; asking the user`);
      return approveOnError(event, ctx, config);
    }
  }

  return async function handle(event, ctx) {
    let config: Config;
    try {
      config = deps.getConfig();
    } catch {
      // No mode to honour: fail open.
      log(`${PREFIX}: gate error; the call runs`);
      return undefined;
    }
    return config.mode === 'off' ? undefined : run(event, ctx, config);
  };
}
