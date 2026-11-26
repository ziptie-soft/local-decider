/** `agent.turn.after` → `turn-outcome`, recorded as a decision row in the agent's timeline. */
import type { PluginHookAgent, PluginTurnOutcome } from '@getpaseo/plugin/server';

import type { DecideResponse } from '../shared/decision.ts';
import { rowVisible, toRowData } from '../shared/row.ts';
import { Background, detach } from './background.ts';
import type { HookDeps, PaseoLike } from './deps.ts';
import { buildTurnInput } from './history.ts';
import { BoundedSet, RateLimiter, ThrottledLog } from './limits.ts';
import { appendRow } from './timeline.ts';

const TURN_POLICY = 'turn-outcome';
const HISTORY_LIMIT = 60;
/** Detached from the hook, so this can exceed the 30 s hook limit; the gateway caps it too. */
export const DECIDE_TIMEOUT_MS = 60_000;

export interface TurnEvent {
  readonly agent: PluginHookAgent;
  readonly turnId: string | null;
  readonly outcome: PluginTurnOutcome;
}

export interface HookCtx<P extends PaseoLike = PaseoLike> {
  readonly paseo: P;
  readonly signal: AbortSignal;
}

/** The plugin changes behaviour only when the gateway enforced AND its own mode is `act`. */
export function pluginEnforces(res: DecideResponse, mode: string): boolean {
  return res.enforced && mode === 'act' && res.error === undefined;
}

/** Stable per turn: the turn id, else the last timeline item's position. */
function turnKey(turnId: string | null, entryCount: number, lastSeq: string): string {
  return turnId ?? `n${entryCount}-${lastSeq}`;
}

export interface TurnHandlerOptions {
  readonly seen?: BoundedSet;
  readonly limiter?: RateLimiter;
  /** Across all agents. */
  readonly globalLimiter?: RateLimiter;
  readonly background?: Background;
}

export function createTurnHandler(
  deps: HookDeps,
  options: TurnHandlerOptions = {},
): (event: TurnEvent, ctx: HookCtx) => Promise<void> {
  const seen = options.seen ?? new BoundedSet(2000);
  // A circuit breaker, not a sampler: a normal agent never ends 30 turns a minute.
  const limiter = options.limiter ?? new RateLimiter(30, 60_000);
  const globalLimiter = options.globalLimiter ?? new RateLimiter(60, 60_000);
  const throttle = new ThrottledLog(60_000);
  const background = options.background ?? new Background();

  // Returns at once: the decision runs detached and appends its row when it returns.
  return async (event, ctx) => {
    detach(
      background,
      (m) => deps.log(m),
      `turn-outcome for ${event.agent.id}`,
      async (signal) =>
        handleTurn(deps, { seen, limiter, globalLimiter, throttle }, event, {
          paseo: ctx.paseo,
          signal,
        }),
    );
  };
}

interface TurnState {
  readonly seen: BoundedSet;
  readonly limiter: RateLimiter;
  readonly globalLimiter: RateLimiter;
  readonly throttle: ThrottledLog;
}

async function handleTurn(
  deps: HookDeps,
  state: TurnState,
  event: TurnEvent,
  ctx: HookCtx,
): Promise<void> {
  // A user cancel is its own answer and Paseo shows a failure as its own error item: classify
  // completed turns only.
  if (event.outcome.kind === 'canceled' || event.outcome.kind === 'failed') {
    return;
  }
  const settings = await deps.settings();
  const mode = settings.modes[TURN_POLICY];
  if (mode === 'off') {
    return;
  }
  const agent = ctx.paseo.agents.ref(event.agent.id);
  const page = await agent.timeline.refetch({ direction: 'tail', limit: HISTORY_LIMIT });
  const entries = page.entries.filter((e) => e.item.type !== 'plugin');
  const turn = turnKey(event.turnId, entries.length, lastSeqOf(entries));
  if (!state.seen.add(`${event.agent.id}:${turn}`)) {
    return;
  }
  if (!state.limiter.allow(event.agent.id) || !state.globalLimiter.allow('*')) {
    state.throttle.emit((m) => deps.log(m), 'turn-outcome skipped: rate limit');
    return;
  }
  const input = buildTurnInput(entries, event.turnId);
  const gateway = await deps.gateway();
  if (input === null || gateway === null) {
    return;
  }
  const res = await gateway.decide(
    TURN_POLICY,
    { harness: 'paseo', sessionId: event.agent.id, input: { ...input } },
    { timeoutMs: DECIDE_TIMEOUT_MS, signal: ctx.signal },
  );
  if (res === null) {
    return;
  }
  const enforced = pluginEnforces(res, mode);
  const data = toRowData(res, {
    source: 'turn',
    key: turn,
    enforced,
    pluginMode: mode,
    ...(enforced && res.action === 'notify' ? { note: noteFor(res) } : {}),
  });
  if (!rowVisible(data, settings.rows.show)) {
    return;
  }
  await appendRow(agent, data);
}

function lastSeqOf(entries: readonly unknown[]): string {
  const last = entries.at(-1) as { seqEnd?: unknown } | undefined;
  return typeof last?.seqEnd === 'number' ? String(last.seqEnd) : '0';
}

function noteFor(res: DecideResponse): string {
  const answer = Object.values(res.answers)[0]?.answer ?? '';
  const notes: Record<string, string> = {
    needs_input: 'The agent is waiting for your input.',
    stuck: 'The agent looks stuck.',
    failed: 'The agent reports a failure.',
  };
  return notes[answer] ?? 'Needs attention.';
}
