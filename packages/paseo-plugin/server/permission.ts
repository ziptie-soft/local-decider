/**
 * `agent.permission.before` → `permission`. Auto-allows only when the gateway enforced an `allow`
 * AND the plugin's permission mode is `act`, and only for shell commands and file edits with a
 * one-shot allow. Never denies: everything else stays pending for the
 * user (ADR-0005). `agent.permission.after` reports the user's answer (`allow`, or a neutral
 * `decline` / `interrupted`) as the ground-truth outcome, redraws the row with it, and registers
 * the row for label chips, which can later report `unsafe` (`labels.ts`). Paseo does not await `before`, so the user can answer
 * before, while or after the decision lands; `settleUser` handles each order exactly once.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from '@getpaseo/protocol/agent-types';

import { isEnforcedAllow, type DecideResponse } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import { rowVisible, toRowData, type DecisionRow } from '../shared/row.ts';
import { Background, detach } from './background.ts';
import { errorText, type HookDeps } from './deps.ts';
import {
  buildPermissionInput,
  firstOfType,
  mergeAssistantChunks,
  taskText,
  transcript,
  type RecentContext,
} from './history.ts';
import { LabelRegistry } from './labels.ts';
import { BoundedMap } from './limits.ts';
import { appendRow } from './timeline.ts';
import { pluginEnforces, type HookCtx } from './turn.ts';

const PERMISSION_POLICY = 'permission';
const HISTORY_LIMIT = 20;
const TIMELINE_FETCH_LIMIT = 100;
/** Detached from the hook; the request stays pending for the user meanwhile. */
const DECIDE_TIMEOUT_MS = 60_000;
/** A send that outlasts this is ambiguous, like a throw. */
const RESPOND_TIMEOUT_MS = 10_000;

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
export function mayAutoAllow(request: AgentPermissionRequest): boolean {
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
}

interface PermissionState {
  readonly pending: BoundedMap<Pending>;
  readonly firstRequests: BoundedMap<string>;
  readonly labels: LabelRegistry;
  readonly now: () => number;
}

export function createPermissionHandlers(
  deps: HookDeps,
  background: Background = new Background(),
  options: PermissionOptions = {},
): {
  before: (event: PermissionEvent, ctx: HookCtx) => Promise<void>;
  after: (event: PermissionResolvedEvent) => Promise<void>;
} {
  const state: PermissionState = {
    pending: new BoundedMap<Pending>(500),
    firstRequests: new BoundedMap<string>(500),
    labels: options.labels ?? new LabelRegistry(),
    now: options.now ?? Date.now,
  };

  // Returns at once: the request stays pending for the user while the decision runs detached.
  const before = async (event: PermissionEvent, ctx: HookCtx): Promise<void> => {
    // Questions, plan approvals and mode switches need a human answer, not an allow.
    if (event.request.kind !== 'tool') {
      return;
    }
    // Tracked synchronously, before any await: an early user answer is then never lost.
    const entry = newPending(ctx.paseo.agents.ref(event.agent.id), event);
    const key = `${event.agent.id}:${event.request.id}`;
    state.pending.set(key, entry);
    detach(
      background,
      (m) => deps.log(m),
      `permission for ${event.agent.id}`,
      async (signal) => {
        try {
          await handleRequest(deps, state, event, entry, signal);
        } finally {
          // No decision to settle later (or an answer already settled): do not keep the entry.
          if (entry.decisionId === null || entry.resolution !== null) {
            state.pending.take(key);
          }
        }
      },
    );
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
  };
}

async function handleRequest(
  deps: HookDeps,
  state: PermissionState,
  event: PermissionEvent,
  entry: Pending,
  signal: AbortSignal,
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
  );
  const res = await decidePermission(gateway, event, context, signal);
  if (res === null) {
    return;
  }
  entry.decisionId = res.decisionId;
  const enforced = pluginEnforces(res, mode);
  if (
    enforced &&
    isEnforcedAllow(res) &&
    mayAutoAllow(event.request) &&
    entry.resolution === null
  ) {
    await autoAllow(state, entry, event.request);
  }
  const data = permissionRow(res, event, entry, enforced);
  if (rowVisible(data, settings.rows.show)) {
    await drawRow(state, entry, data);
  }
  await settleUser(deps, state, entry);
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
  entry.applied = await tryAllow(entry.agent, request, response);
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
): DecisionRow {
  return {
    ...toRowData(res, {
      source: 'permission',
      key: event.request.id,
      enforced,
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
): Promise<RecentContext> {
  let items: AgentTimelineItem[] = [];
  try {
    const page = await agent.timeline.refetch({ direction: 'tail', limit: TIMELINE_FETCH_LIMIT });
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

async function decidePermission(
  gateway: Gateway,
  event: PermissionEvent,
  context: RecentContext,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Gateway['decide']>>> {
  const input = buildPermissionInput(event.agent.cwd, context.history, context.task, event.request);
  return gateway.decide(
    PERMISSION_POLICY,
    {
      harness: 'paseo',
      sessionId: event.agent.id,
      workspace: { cwd: event.agent.cwd },
      input: { ...input },
    },
    { timeoutMs: DECIDE_TIMEOUT_MS, signal },
  );
}

/**
 * True when the daemon confirmed our allow. A throw or a timeout is ambiguous (it may have been
 * applied, or the user answered first): false, and the caller keeps the outcome as ours.
 */
async function tryAllow(
  agent: AgentRef,
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('respondToPermission timed out')),
      RESPOND_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([agent.respondToPermission({ requestId: request.id, response }), expired]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
