/**
 * `agent.permission.before` → `permission`. Auto-allows only when the gateway enforced an `allow`
 * AND the plugin's permission mode is `act`, and only for shell commands and file edits with a
 * one-shot allow. Never denies: everything else stays pending for the
 * user (ADR-0005). `agent.permission.after` reports the user's answer (`allow`, or a neutral
 * `decline` / `interrupted`) as the ground-truth outcome, redraws the row with it, and registers
 * the row for label chips, which can later report `unsafe` (`labels.ts`). Paseo does not await `before`, so the user can answer
 * before, while or after the decision lands; `settleUser` handles each order exactly once.
 * Paseo does not replay `before`, so a request pending at plugin start stays with the user.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from '@getpaseo/protocol/agent-types';

import { isEnforcedAllow, type DecideResponse, type Mode } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import {
  placeholderRow,
  rowVisible,
  toRowData,
  type DecisionRow,
  type SkipReason,
} from '../shared/row.ts';
import { Background, detach } from './background.ts';
import { touchesConfig } from './config-guard.ts';
import { deterministicBlock } from './core/block.ts';
import { asRecord } from './core/subject.ts';
import { errorText, type HookDeps } from './deps.ts';
import {
  buildPermissionInput,
  firstOfType,
  mergeAssistantChunks,
  subjectInput,
  taskText,
  transcript,
  type RecentContext,
} from './history.ts';
import { LabelRegistry } from './labels.ts';
import { BoundedMap, RateLimiter, ThrottledLog } from './limits.ts';
import { appendRow } from './timeline.ts';
import { pluginEnforces, type HookCtx } from './turn.ts';

const PERMISSION_POLICY = 'permission';
const HISTORY_LIMIT = 20;
const TIMELINE_FETCH_LIMIT = 100;
/**
 * From the hook's start to the end of the decision: a parent that supervises the agent answers
 * within ~12 s (`docs/supervised-subagents.md`), so a later decision is wasted engine work. A
 * timeout means no row and no allow; the request stays pending for the user.
 */
const PERMISSION_DEADLINE_MS = 10_000;
/** Below this much of the deadline left, the gateway call is skipped. */
const MIN_PERMISSION_DECIDE_MS = 1000;
/** A circuit breaker, not a sampler: a normal agent never asks 20 times a minute. */
const AGENT_LIMIT = 20;
const GLOBAL_LIMIT = 120;
const LIMIT_WINDOW_MS = 60_000;
/** A send that outlasts this is ambiguous, like a throw. */
const RESPOND_TIMEOUT_MS = 10_000;
/** A decision still running this long after it started gets a "deciding…" row. */
const PENDING_AFTER_MS = 1000;

export interface PermissionEvent {
  readonly agent: PluginHookAgent;
  readonly request: AgentPermissionRequest;
}

export interface PermissionResolvedEvent {
  readonly agent: PluginHookAgent;
  readonly requestId: string;
  readonly resolution: AgentPermissionResponse;
}

type AgentRef = ReturnType<HookCtx['paseo']['agents']['ref']>;

/** Per-request state, from the moment the decision starts until the request is resolved. */
interface Pending {
  readonly agent: AgentRef;
  readonly agentId: string;
  readonly supervised: boolean;
  decisionId: string | null;
  /**
   * True from the moment our allow is sent, and it stays true when the send fails or times out
   * (the daemon may have applied it): its own `after` is then not a user outcome. Only a
   * non-allow answer seen during a failed send proves the user answered.
   */
  autoAllowed: boolean;
  /** True only when `respondToPermission` confirmed our allow. */
  applied: boolean;
  /** The user's answer as an outcome (`allow|decline|interrupted`), once reported. */
  resolution: string | null;
  /** Epoch ms (daemon clock) of the user's answer or our auto-allow; null until then. */
  answeredAt: number | null;
  reported: boolean;
  /** The row as last appended; null until appended, or when hidden. */
  row: DecisionRow | null;
  /** True once a "deciding…" row is drawn: its id must then end in a final row. */
  pendingDrawn: boolean;
  /** The pending row's append; the final row waits for it so it always lands last. */
  pendingDraw: Promise<void> | null;
}

const PERSISTENT_ACTION =
  /always|session|remember|persist|forever|permanent|don'?t ask|do not ask|every|all |future|project|settings|rule/i;
const ONE_SHOT_ACTION = /(^|[^a-z])(once|one[-_ ]?time|this time|just this|only this)/i;
const PLAIN_ALLOW_ACTION = /^(allow|yes|approve|accept)$/i;

function oneShot(action: AgentPermissionAction): boolean {
  const text = `${action.id} ${action.label}`;
  if (PERSISTENT_ACTION.test(text)) {
    return false;
  }
  return (
    ONE_SHOT_ACTION.test(text) ||
    PLAIN_ALLOW_ACTION.test(action.id) ||
    PLAIN_ALLOW_ACTION.test(action.label)
  );
}

/**
 * The one-shot allow ("this time only"), never "always" or "allow for the session". A request
 * without actions takes a plain allow, which carries no permission update. When it offers allow
 * actions but none is recognisably one-shot, returns null: the plugin abstains.
 */
export function allowResponse(request: AgentPermissionRequest): AgentPermissionResponse | null {
  const allows = (request.actions ?? []).filter((a) => a.behavior === 'allow');
  if (allows.length === 0) {
    return { behavior: 'allow' };
  }
  const once = allows.filter(oneShot);
  const action = once.find((a) => a.variant === 'primary') ?? once[0];
  return action === undefined ? null : { behavior: 'allow', selectedActionId: action.id };
}

const SHELL_TOOLS = ['Bash', 'shell', 'exec_command'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'];
const EDIT_DETAILS = ['edit', 'write'];

/**
 * True for shell commands and file edits only, the tools the hooks may auto-allow too
 * (`packages/hooks/src/permission-tools.ts`). Plan approval, questions, `mcp__*` and unknown
 * tools stay with the user.
 */
function mayAutoAllow(request: AgentPermissionRequest): boolean {
  const detail = request.detail?.type;
  if (request.kind !== 'tool' || request.name.startsWith('mcp__')) {
    return false;
  }
  return (
    SHELL_TOOLS.includes(request.name) ||
    EDIT_TOOLS.includes(request.name) ||
    detail === 'shell' ||
    (detail !== undefined && EDIT_DETAILS.includes(detail))
  );
}

/** The user's answer as an outcome: a decline is neutral until labelled (ADR-0006 addendum). */
function userOutcome(resolution: AgentPermissionResponse): 'allow' | 'decline' | 'interrupted' {
  if (resolution.behavior === 'allow') {
    return 'allow';
  }
  return resolution.interrupt === true ? 'interrupted' : 'decline';
}

export interface PermissionOptions {
  readonly labels?: LabelRegistry;
  readonly now?: () => number;
  /** Tests only: the decision deadline, and the least of it worth a gateway call. */
  readonly deadlineMs?: number;
  readonly minDecideMs?: number;
  /** Tests only: how long a decision runs before its "deciding…" row is drawn. */
  readonly pendingAfterMs?: number;
}

interface PermissionState {
  readonly pending: BoundedMap<Pending>;
  readonly firstRequests: BoundedMap<string>;
  readonly labels: LabelRegistry;
  readonly now: () => number;
  readonly logAllow: (result: AllowResult, error: unknown) => void;
  readonly perAgent: RateLimiter;
  readonly global: RateLimiter;
  readonly limitLog: ThrottledLog;
  readonly deadlineMs: number;
  readonly minDecideMs: number;
  readonly pendingAfterMs: number;
  /** One skipped row per agent per minute, so a flood cannot flood the timeline. */
  readonly skipLimiter: RateLimiter;
}

export function createPermissionHandlers(
  deps: HookDeps,
  background: Background = new Background(),
  options: PermissionOptions = {},
): {
  before: (event: PermissionEvent, ctx: HookCtx) => Promise<void>;
  after: (event: PermissionResolvedEvent) => Promise<void>;
} {
  const now = options.now ?? Date.now;
  const state: PermissionState = {
    pending: new BoundedMap<Pending>(500),
    firstRequests: new BoundedMap<string>(500),
    labels: options.labels ?? new LabelRegistry(),
    now,
    logAllow: createAllowLogger(now, (m) => deps.log(m)),
    perAgent: new RateLimiter(AGENT_LIMIT, LIMIT_WINDOW_MS, now),
    global: new RateLimiter(GLOBAL_LIMIT, LIMIT_WINDOW_MS, now),
    limitLog: new ThrottledLog(LIMIT_WINDOW_MS, now),
    deadlineMs: options.deadlineMs ?? PERMISSION_DEADLINE_MS,
    minDecideMs: options.minDecideMs ?? MIN_PERMISSION_DECIDE_MS,
    pendingAfterMs: options.pendingAfterMs ?? PENDING_AFTER_MS,
    skipLimiter: new RateLimiter(1, LIMIT_WINDOW_MS, now),
  };

  // Returns at once: the request stays pending for the user while the decision runs detached.
  const before = async (event: PermissionEvent, ctx: HookCtx): Promise<void> => {
    // Questions, plan approvals and mode switches need a human answer, not an allow.
    if (event.request.kind !== 'tool') {
      return;
    }
    const agent = ctx.paseo.agents.ref(event.agent.id);
    // Over a limit: no decision and no entry; the request stays with the user.
    if (!underLimits(deps, state, event.agent.id)) {
      await drawSkipped(deps, state, { agent, event, reason: 'rate-limit' });
      return;
    }
    const end = state.now() + state.deadlineMs;
    // Tracked synchronously, before any await: an early user answer is then never lost.
    const entry = newPending(agent, event);
    const key = `${event.agent.id}:${event.request.id}`;
    state.pending.set(key, entry);
    const started = detach(
      background,
      (m) => deps.log(m),
      `permission for ${event.agent.id}`,
      async (signal) => {
        try {
          await handleRequest(deps, state, event, entry, deadlineOf(state, end, signal));
        } finally {
          // No decision to settle later (or an answer already settled): do not keep the entry.
          if (entry.decisionId === null || entry.resolution !== null) {
            state.pending.take(key);
          }
        }
      },
    );
    if (!started) {
      state.pending.take(key);
      await drawSkipped(deps, state, { agent, event, reason: 'busy' });
    }
  };

  const after = async (event: PermissionResolvedEvent): Promise<void> => {
    const entry = state.pending.take(`${event.agent.id}:${event.requestId}`);
    if (entry === undefined) {
      return;
    }
    entry.resolution = userOutcome(event.resolution);
    entry.answeredAt = state.now();
    await settleUser(deps, state, entry);
  };

  return { before, after };
}

function underLimits(deps: HookDeps, state: PermissionState, agentId: string): boolean {
  if (state.perAgent.allow(agentId) && state.global.allow('*')) {
    return true;
  }
  state.limitLog.emit(
    (m) => deps.log(m),
    'permission skipped: rate limit, requests stay with the user',
  );
  return false;
}

/** The end of one request's decision window: aborts with the hook's signal or at the deadline. */
interface Deadline {
  readonly signal: AbortSignal;
  remaining(): number;
}

function deadlineOf(state: PermissionState, end: number, signal: AbortSignal): Deadline {
  const remaining = (): number => Math.max(0, end - state.now());
  return { signal: AbortSignal.any([signal, AbortSignal.timeout(remaining())]), remaining };
}

function newPending(agent: AgentRef, event: PermissionEvent): Pending {
  return {
    agent,
    agentId: event.agent.id,
    supervised: event.agent.parentAgentId !== null,
    decisionId: null,
    autoAllowed: false,
    applied: false,
    resolution: null,
    answeredAt: null,
    reported: false,
    row: null,
    pendingDrawn: false,
    pendingDraw: null,
  };
}

/** The tool name the deterministic checks know, for Paseo requests named by their `detail`. */
function checkedTool(request: AgentPermissionRequest): string {
  const detail = request.detail?.type;
  if (SHELL_TOOLS.includes(request.name) || EDIT_TOOLS.includes(request.name)) {
    return request.name;
  }
  return detail === 'shell' ? 'Bash' : 'Edit';
}

/** Never auto-allow a call the deterministic checks flag (or one with no working directory). */
function pathsSafe(event: PermissionEvent): boolean {
  const cwd = event.agent.cwd;
  const { request } = event;
  if (typeof cwd !== 'string' || cwd === '') {
    return false;
  }
  const input = subjectInput(request);
  const fields = asRecord(input);
  const path = fields?.['filePath'];
  const checked = typeof path === 'string' ? { ...fields, file_path: path } : input;
  const tool = checkedTool(request);
  return deterministicBlock(tool, checked, cwd) === null && !touchesConfig(cwd, tool, input);
}

async function handleRequest(
  deps: HookDeps,
  state: PermissionState,
  event: PermissionEvent,
  entry: Pending,
  deadline: Deadline,
): Promise<void> {
  const settings = await deps.settings();
  const mode = settings.modes[PERMISSION_POLICY];
  const gateway = await deps.gateway();
  if (mode === 'off' || gateway === null) {
    return;
  }
  const context = await recentContext(
    entry.agent,
    event.agent.id,
    state.firstRequests,
    event.agent.title,
    deadline.signal,
  );
  if (deadline.remaining() < state.minDecideMs) {
    deps.log('permission skipped: deadline spent before decide');
    await drawSkipped(deps, state, { agent: entry.agent, event, reason: 'deadline' });
    return;
  }
  const res = await withPending(deps, state, { event, entry, settings }, async () =>
    decidePermission(gateway, event, context, deadline),
  );
  if (res === null) {
    return;
  }
  entry.decisionId = res.decisionId;
  const enforced = pluginEnforces(res, mode);
  if (enforced && mayAllow(res, event, entry)) {
    await autoAllow(state, entry, event.request);
  }
  const data = permissionRow(res, event, entry, enforced, mode);
  // A drawn "deciding…" row must end in the decided row, whatever `rows.show` says.
  if (entry.pendingDrawn || rowVisible(data, settings.rows.show)) {
    await drawRow(state, entry, data);
  }
  await settleUser(deps, state, entry);
}

type Settings = Awaited<ReturnType<HookDeps['settings']>>;

/** Placeholder rows (deciding…, skipped) show only where a user waits on us: plugin `act`. */
function showsPlaceholders(settings: Settings): boolean {
  return settings.modes[PERMISSION_POLICY] === 'act' && settings.rows.show !== 'off';
}

/** Appends a placeholder row. Fails open: an error is logged, never thrown. */
async function drawPlaceholder(deps: HookDeps, agent: AgentRef, row: DecisionRow): Promise<void> {
  try {
    await appendRow(agent, row);
  } catch (error) {
    deps.log(`permission placeholder row not drawn: ${errorText(error)}`);
  }
}

/**
 * Draws a "skipped: <reason> · answer it yourself" row, at most one per agent a minute, in `act`
 * only (in shadow nobody waits on the decider). Runs outside `Background`, so it is never refused.
 */
async function drawSkipped(
  deps: HookDeps,
  state: PermissionState,
  skipped: { agent: AgentRef; event: PermissionEvent; reason: SkipReason },
): Promise<void> {
  const { agent, event, reason } = skipped;
  try {
    if (!showsPlaceholders(await deps.settings()) || !state.skipLimiter.allow(event.agent.id)) {
      return;
    }
  } catch (error) {
    deps.log(`permission placeholder row not drawn: ${errorText(error)}`);
    return;
  }
  const row = placeholderRow('permission', event.request.id, PERMISSION_POLICY, 'skipped', reason);
  await drawPlaceholder(deps, agent, row);
}

/**
 * Runs `decide`, drawing a "deciding…" row if it is still running after `pendingAfterMs` and the
 * user has not answered. The pending row is always finalized: by the caller's decided row, or here
 * with a "not decided" row when there is no decision.
 */
async function withPending<T>(
  deps: HookDeps,
  state: PermissionState,
  ctx: { event: PermissionEvent; entry: Pending; settings: Settings },
  decide: () => Promise<T | null>,
): Promise<T | null> {
  const { event, entry, settings } = ctx;
  const timer = showsPlaceholders(settings)
    ? setTimeout(() => {
        if (entry.resolution === null) {
          entry.pendingDrawn = true;
          const row = placeholderRow('permission', event.request.id, PERMISSION_POLICY, 'pending');
          entry.pendingDraw = drawPlaceholder(deps, entry.agent, row);
        }
      }, state.pendingAfterMs)
    : undefined;
  let result: T | null = null;
  try {
    result = await decide();
  } finally {
    clearTimeout(timer);
    await entry.pendingDraw;
    if (result === null && entry.pendingDrawn) {
      const row = placeholderRow(
        'permission',
        event.request.id,
        PERMISSION_POLICY,
        'skipped',
        'no-answer',
      );
      await drawPlaceholder(deps, entry.agent, row);
    }
  }
  return result;
}

function mayAllow(res: DecideResponse, event: PermissionEvent, entry: Pending): boolean {
  return (
    isEnforcedAllow(res) &&
    mayAutoAllow(event.request) &&
    pathsSafe(event) &&
    entry.resolution === null
  );
}

/**
 * Sends our one-shot allow. `autoAllowed` is set before awaiting (our own `after` can fire while
 * the response is in flight) and stays set on a failure: the daemon may have applied it, so
 * the outcome is ours, never a verified user allow. A non-allow answer seen meanwhile is the
 * user's: it cannot be our allow.
 */
async function autoAllow(
  state: PermissionState,
  entry: Pending,
  request: AgentPermissionRequest,
): Promise<void> {
  const response = allowResponse(request);
  if (response === null) {
    return;
  }
  entry.autoAllowed = true;
  entry.applied = (await tryAllow(entry, request, response, state.logAllow)) === 'applied';
  if (entry.applied) {
    entry.answeredAt = state.now();
  } else if (entry.resolution !== null && entry.resolution !== 'allow') {
    entry.autoAllowed = false;
  }
}

function permissionRow(
  res: DecideResponse,
  event: PermissionEvent,
  entry: Pending,
  enforced: boolean,
  pluginMode: Mode,
): DecisionRow {
  return {
    ...toRowData(res, {
      source: 'permission',
      key: event.request.id,
      enforced,
      pluginMode,
      applied: entry.applied,
      note: `${event.request.name}${entry.applied ? ' auto-allowed' : ''}`,
    }),
    feedback: entry.autoAllowed ? null : entry.resolution,
    answeredAt: entry.applied || entry.resolution !== null ? entry.answeredAt : null,
  };
}

/** Draw through one place, so the label registry always matches the drawn row. */
async function drawRow(state: PermissionState, entry: Pending, row: DecisionRow): Promise<void> {
  await appendRow(entry.agent, row);
  entry.row = row;
  state.labels.note(entry.agentId, row);
}

/**
 * Once both the decision and the user's answer are known: report the answer as the `user`
 * outcome and redraw the row with it. Idempotent; a no-op for our own auto-allow.
 */
async function settleUser(deps: HookDeps, state: PermissionState, entry: Pending): Promise<void> {
  const resolution = entry.resolution;
  if (resolution === null || entry.autoAllowed || entry.decisionId === null) {
    return;
  }
  if (!entry.reported) {
    entry.reported = true;
    await reportUser(deps, entry.decisionId, resolution, entry.supervised);
  }
  const row = entry.row;
  if (row !== null && row.feedback === null) {
    try {
      await drawRow(state, entry, { ...row, feedback: resolution, answeredAt: entry.answeredAt });
    } catch (error) {
      deps.log(`permission row not updated: ${errorText(error)}`);
    }
  }
}

async function reportUser(
  deps: HookDeps,
  decisionId: string,
  resolution: string,
  supervised: boolean,
): Promise<void> {
  try {
    const gateway = await deps.gateway();
    await gateway?.reportOutcome(decisionId, resolution, supervised ? 'supervised' : 'user');
  } catch (error) {
    deps.log(`permission outcome not reported: ${errorText(error)}`);
  }
}

async function recentContext(
  agent: AgentRef,
  agentId: string,
  firstRequests: BoundedMap<string>,
  title: string | null | undefined,
  signal: AbortSignal,
): Promise<RecentContext> {
  let items: AgentTimelineItem[] = [];
  try {
    const page = await Promise.race([
      agent.timeline.refetch({ direction: 'tail', limit: TIMELINE_FETCH_LIMIT }),
      abortion(signal),
    ]);
    items = page.entries.map((e) => e.item).filter((item) => item.type !== 'plugin');
    const first = firstOfType(items, 'user_message')?.text.trim();
    if (firstRequests.get(agentId) === undefined && first !== undefined && first !== '') {
      firstRequests.set(agentId, first);
    }
  } catch {
    // The cached first request and agent title still make useful task context when refetch fails.
  }
  const recent = mergeAssistantChunks(items.slice(-HISTORY_LIMIT));
  return {
    history: transcript(recent, 6000),
    task: taskText(items, firstRequests.get(agentId), title),
  };
}

/** Never resolves; rejects when `signal` aborts. */
async function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new Error('permission deadline reached'));
    if (signal.aborted) {
      fail();
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

async function decidePermission(
  gateway: Gateway,
  event: PermissionEvent,
  context: RecentContext,
  deadline: Deadline,
): Promise<Awaited<ReturnType<Gateway['decide']>>> {
  const input = buildPermissionInput(event.agent.cwd, context.history, context.task, event.request);
  return gateway.decide(
    PERMISSION_POLICY,
    {
      harness: 'paseo',
      sessionId: event.agent.id,
      workspace: { cwd: event.agent.cwd },
      input,
    },
    { timeoutMs: deadline.remaining(), signal: deadline.signal },
  );
}

type AllowResult = 'applied' | 'timeout' | 'answered' | 'rejected';

const TIMED_OUT = 'respondToPermission timed out';

/**
 * `applied` when the daemon confirmed our allow. Anything else is ambiguous (it may have been
 * applied, or the user answered first): the caller keeps the outcome as ours. `answered` is a
 * rejection after the user's answer, which is benign.
 */
async function tryAllow(
  entry: Pending,
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
  onFail: (result: AllowResult, error: unknown) => void,
): Promise<AllowResult> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), RESPOND_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      entry.agent.respondToPermission({ requestId: request.id, response }),
      expired,
    ]);
    return 'applied';
  } catch (error) {
    const result: AllowResult =
      entry.resolution !== null
        ? 'answered'
        : error instanceof Error && error.message === TIMED_OUT
          ? 'timeout'
          : 'rejected';
    onFail(result, error);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Logs a failed allow; rejections are rate limited, with a count of the suppressed lines. */
function createAllowLogger(
  now: () => number,
  log: (m: string) => void,
): (result: AllowResult, error: unknown) => void {
  const rejections = new ThrottledLog(60_000, now);
  return (result, error) => {
    if (result === 'timeout') {
      log('permission allow timed out');
    } else if (result === 'rejected') {
      const line = errorText(error).split('\n')[0]?.slice(0, 200) ?? '';
      rejections.emit(log, `permission allow not applied: ${line}`);
    }
  };
}
