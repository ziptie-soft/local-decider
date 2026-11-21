import {
  buildState,
  type BuiltState,
  canonicalJson,
  CHARS_PER_TOKEN,
  evaluateRules,
  guardTruncation,
  inputHash,
  normaliseAnswers,
  type OutcomeRecord,
  policyQuestions,
  policySections,
  policyThresholds,
  redactDeep,
  withThresholds,
  sortKeysDeep,
  type Answers,
  type DecideRequest,
  type DecideResponse,
  type LogRecord,
  minMode,
  type Mode,
  type Policy,
  type PolicyThreshold,
  type PrecedentTally,
  type Questions,
  type Scope,
  type ShadowRecord,
  type SystemOneRequest,
  type SystemOneResponse,
  resolveSegments,
} from '@ziptie-soft/local-decider-core';
import { randomUUID } from 'node:crypto';

import { CallStore, type CallDecision } from './call-store.ts';
import { EngineBusyError } from './engine-busy.ts';
import { ENGINE_BUSY_ERROR, isEngineBusy, type Engine } from './engines/types.ts';
import type { LogStore } from './log-store.ts';
import type { LoadedPolicy } from './policies.ts';
import { PrecedentStore } from './precedent.ts';
import {
  ABANDON_GRACE_MS,
  admissionLimit,
  LatencyWindow,
  QueueFullError,
  SerialQueue,
  type Priority,
  type QueueLimits,
} from './queue.ts';

const CACHE_MAX = 500;
type PrecedentSettings = NonNullable<Policy['precedent']>;

/** Decisions waiting for or holding the engine before new ones are refused (fail open, logged). */
export const QUEUE_MAX = 8;
/**
 * Of QUEUE_MAX, slots `normal` decisions may not take. `low` ones may fill the queue: a `high`
 * decision arriving at QUEUE_MAX evicts the oldest waiting `low` one.
 */
const QUEUE_HIGH_RESERVE = 2;

/** Queue limits for an engine running `slots` jobs at once: the same 7 waiting places beyond them. */
function queueLimits(slots: number): QueueLimits {
  return { max: QUEUE_MAX - 1 + slots, highReserve: QUEUE_HIGH_RESERVE };
}

/** Pass-through jobs wait behind decisions. */
const PASS_THROUGH_PRIORITY: Priority = 'low';

/** Recent engine jobs timed for the busy estimate; `replaceEngine` clears them. */
const SERVICE_WINDOW = 50;

/**
 * Milliseconds a new job waits for a slot: each full wave of `slots` jobs ahead of it takes one
 * mean service time. Zero while a slot is free or nothing has been timed yet.
 */
export function estimateWaitMs(
  depth: number,
  slots: number,
  meanServiceMs: number | undefined,
): number {
  return meanServiceMs === undefined ? 0 : Math.floor(depth / slots) * meanServiceMs;
}

function precedentWindow(policies: ReadonlyMap<string, LoadedPolicy>): number | undefined {
  let days: number | undefined;
  for (const { policy } of policies.values()) {
    const age = policy.precedent?.maxAgeDays;
    if (age !== undefined && (days === undefined || age > days)) {
      days = age;
    }
  }
  return days;
}

function samePrecedentSettings(
  current: ReadonlyMap<string, LoadedPolicy>,
  next: ReadonlyMap<string, LoadedPolicy>,
): boolean {
  const previous = precedentSettings(current);
  const replacement = precedentSettings(next);
  return (
    previous.size === replacement.size &&
    [...previous].every(([id, settings]) => replacement.get(id) === settings)
  );
}

function precedentSettings(policies: ReadonlyMap<string, LoadedPolicy>): Map<string, string> {
  const settings = new Map<string, string>();
  for (const [id, { policy }] of policies) {
    const precedent: PrecedentSettings | undefined = policy.precedent;
    if (precedent !== undefined) {
      settings.set(id, canonicalJson(precedent));
    }
  }
  return settings;
}

export class UnknownPolicyError extends Error {
  override readonly name = 'UnknownPolicyError';
}

export interface DeciderOptions {
  readonly engine: Engine;
  readonly policies: ReadonlyMap<string, LoadedPolicy>;
  readonly log: LogStore;
  readonly decisionTimeoutMs: number;
  readonly now?: () => Date;
  /** How long an engine job that ignores its deadline keeps the engine; default 1 s. For tests. */
  readonly queueGraceMs?: number;
}

interface CacheEntry {
  readonly answers: Answers;
  readonly expires: number;
}

interface EngineResult {
  readonly answers: Answers;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly error?: string;
  /** Admission to slot start, including any model load wait; absent unless the engine ran. */
  readonly queueMs?: number;
  /** The engine call's duration; absent unless the engine ran. */
  readonly engineMs?: number;
}

/** How a decision enters the engine queue. */
interface Admission {
  readonly signal: AbortSignal;
  readonly priority: Priority;
  /** The caller's wait budget; a longer estimated queue wait refuses the decision as busy. */
  readonly budgetMs?: number;
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { low: 0, normal: 1, high: 2 };

/** An engine call that identical concurrent requests share. */
interface SharedCall {
  readonly hash: string;
  readonly priority: Priority;
  readonly controller: AbortController;
  readonly promise: Promise<EngineResult>;
  waiters: number;
}

interface PrecedentDecision {
  readonly key: string;
  readonly tally: PrecedentTally;
  readonly allows: boolean;
}

/** Strings pass through; everything else becomes key-sorted JSON. */
export function renderValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** The policy pipeline: redact → state → cache → engine (serial) → rules → shadow log. */
export class Decider {
  #engine: Engine;
  #policies: Map<string, LoadedPolicy>;
  /** Policy id → the variant answering for it, when not the policy itself. */
  readonly #variants = new Map<string, string>();
  /** Policy id → rule threshold overrides by `<question>.<answer>`, for that policy's own rules. */
  readonly #thresholds = new Map<string, Readonly<Record<string, number>>>();
  readonly #log: LogStore;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #queue: SerialQueue;
  /** Decisions waiting for a managed engine to load (outside the queue). */
  #preparing = 0;
  #holdReason: string | null = null;
  #switchReason: string | null = null;
  /** Bumped by hold and replaceEngine: answers computed before it must not enter the cache. */
  #generation = 0;
  readonly #latency = new LatencyWindow();
  /** Time inside the engine call only (no queue wait), for `budgetMs` admission. */
  readonly #service = new LatencyWindow(SERVICE_WINDOW);
  readonly #cache = new Map<string, CacheEntry>();
  /** Engine calls running now by input hash; identical requests join instead of calling again. */
  readonly #inflight = new Map<string, SharedCall>();
  readonly #precedent: PrecedentStore;
  /** Recent harness tool calls and what each policy decided for them. */
  readonly calls = new CallStore();
  #failureHandler: ((engine: Engine) => void) | undefined;
  #successHandler: ((engine: Engine) => void) | undefined;

  constructor(options: DeciderOptions) {
    this.#engine = options.engine;
    this.#queue = new SerialQueue({
      abandonGraceMs: options.queueGraceMs ?? ABANDON_GRACE_MS,
      ...(options.engine.concurrency === undefined
        ? {}
        : { concurrency: options.engine.concurrency }),
    });
    this.#policies = new Map(options.policies);
    this.#log = options.log;
    this.#timeoutMs = options.decisionTimeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#precedent = new PrecedentStore(
      (id) => this.#policies.get(id)?.policy.precedent,
      () => this.#now().getTime(),
    );
  }

  get policies(): ReadonlyMap<string, LoadedPolicy> {
    return this.#policies;
  }

  get engine(): Engine {
    return this.#engine;
  }

  /** Why decisions currently fail open, or null. */
  get held(): string | null {
    return this.#blocked;
  }

  /** Fail open while a gateway operation temporarily owns the engine. */
  hold(reason: string | null): void {
    this.#holdReason = reason;
    this.#invalidate();
  }

  /**
   * The same fail-open hold for an engine switch, kept apart from `hold` so a benchmark's release
   * cannot end it early and vice versa.
   */
  holdSwitch(reason: string | null): void {
    this.#switchReason = reason;
    this.#invalidate();
  }

  #invalidate(): void {
    this.#generation += 1;
    this.#cache.clear();
    this.#inflight.clear();
  }

  /** The reason decisions fail open now, from either hold. */
  get #blocked(): string | null {
    return this.#holdReason ?? this.#switchReason;
  }

  /** Throws for a queued job whose engine was replaced or held since it was enqueued. */
  #assertCurrent(generation: number): void {
    const reason = this.#blocked;
    if (reason !== null) {
      throw new EngineBusyError(reason);
    }
    if (generation !== this.#generation) {
      throw new EngineBusyError('engine changed');
    }
  }

  /** Called with the engine that errored, so a supervisor can check its health. */
  onEngineFailure(handler: (engine: Engine) => void): void {
    this.#failureHandler = handler;
  }

  /** Called with the engine that answered, so a supervisor knows a lazy engine is healthy. */
  onEngineSuccess(handler: (engine: Engine) => void): void {
    this.#successHandler = handler;
  }

  /** Change a policy's run mode in place; false when the policy is unknown. */
  setMode(id: string, mode: Mode): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    this.#policies.set(id, { ...loaded, mode });
    return true;
  }

  /** Set the per-scope mode caps of policy `id`; `{}` clears them. False for an unknown policy. */
  setScopeModes(id: string, modes: Partial<Record<Scope, Mode>>): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    this.#policies.set(id, { ...loaded, scopes: modes });
    return true;
  }

  /** The mode policy `id` runs in for `scope`: its own, capped by the scope's (default shadow). */
  effectiveMode(id: string, scope?: Scope): Mode {
    const loaded = this.#policies.get(id);
    const mode = loaded?.mode ?? 'off';
    return scope === undefined ? mode : minMode(mode, loaded?.scopes?.[scope] ?? 'shadow');
  }

  /**
   * Override rule thresholds of policy `id` (its own rules, also when it answers as a variant);
   * `{}` restores the file's. Keys naming no rule are dropped. False when the policy is unknown.
   */
  setThresholds(id: string, thresholds: Readonly<Record<string, number>>): boolean {
    const loaded = this.#policies.get(id);
    if (loaded === undefined) {
      return false;
    }
    const known = new Set(policyThresholds(loaded.policy).map((t) => t.key));
    const kept = Object.entries(thresholds).filter(([key]) => known.has(key));
    if (kept.length === 0) {
      this.#thresholds.delete(id);
    } else {
      this.#thresholds.set(id, Object.fromEntries(kept));
    }
    return true;
  }

  /** The rule thresholds of policy `id` with their defaults and values in effect. */
  thresholdsOf(id: string): PolicyThreshold[] {
    const loaded = this.#policies.get(id);
    return loaded === undefined
      ? []
      : policyThresholds(loaded.policy, this.#thresholds.get(id) ?? {});
  }

  /** Answer `id` with policy `variant` (`id` itself restores the default); false when it can't. */
  setVariant(id: string, variant: string): boolean {
    if (!this.#canAnswer(id, variant)) {
      return false;
    }
    if (variant === id) {
      this.#variants.delete(id);
    } else {
      this.#variants.set(id, variant);
    }
    return true;
  }

  /** The policy that answers for `id` now. */
  activeVariant(id: string): string {
    return this.#variants.get(id) ?? id;
  }

  /** Policies that can answer for `id`: itself first, then its variants by id. */
  variantsOf(id: string): string[] {
    const variants = [...this.#policies.values()]
      .filter(({ policy }) => policy.variantOf === id)
      .map(({ policy }) => policy.id)
      .toSorted();
    const base = this.#policies.get(id);
    return base === undefined || base.policy.variantOf !== undefined ? [] : [id, ...variants];
  }

  /**
   * Serve reloaded policies. Cached answers belong to the old questions and are dropped, and a
   * variant choice whose policy is gone falls back to the default, and threshold overrides keep
   * only keys that still name a rule. Modes come with `next`.
   */
  replacePolicies(next: ReadonlyMap<string, LoadedPolicy>): void {
    const precedentChanged = !samePrecedentSettings(this.#policies, next);
    this.#policies = new Map(next);
    this.#cache.clear();
    for (const [id, thresholds] of this.#thresholds) {
      if (!this.setThresholds(id, thresholds)) {
        this.#thresholds.delete(id);
      }
    }
    for (const [id, variant] of this.#variants) {
      if (!this.#canAnswer(id, variant)) {
        this.#variants.delete(id);
      }
    }
    if (precedentChanged) {
      this.#precedent.rebuild(this.#recentPrecedentRecords());
    }
  }

  /** Rebuild precedent once from the append-only decision log during startup. */
  /** Rebuild from the selected backend, allowing SQLite to query only verified outcomes. */
  rebuildPrecedent(records?: readonly LogRecord[]): void {
    this.#precedent.rebuild(records ?? this.#recentPrecedentRecords());
  }

  /** Add a reported outcome to recent precedent evidence. */
  noteOutcome(outcome: OutcomeRecord): void {
    this.#precedent.noteOutcome(outcome);
  }

  #canAnswer(id: string, variant: string): boolean {
    const base = this.#policies.get(id);
    if (base === undefined || base.policy.variantOf !== undefined) {
      return false;
    }
    return variant === id || this.#policies.get(variant)?.policy.variantOf === id;
  }

  #recentPrecedentRecords(): LogRecord[] {
    const days = precedentWindow(this.#policies);
    if (days === undefined) {
      return [];
    }
    const now = this.#now().getTime();
    return this.#log.readVerifiedPrecedent(days, now);
  }

  /**
   * The requested policy's mode with the selected variant's questions and rules, the rules with
   * that variant's threshold overrides.
   */
  #resolve(policyId: string, scope?: Scope): { mode: Mode; policy: Policy; variant?: string } {
    const loaded = this.#policies.get(policyId);
    if (loaded === undefined) {
      throw new UnknownPolicyError(`unknown policy "${policyId}"`);
    }
    const selected = this.#policies.get(this.activeVariant(policyId));
    const answering = selected ?? loaded;
    const policy = withThresholds(
      answering.policy,
      this.#thresholds.get(answering.policy.id) ?? {},
    );
    const mode = this.effectiveMode(policyId, scope);
    return answering === loaded ? { mode, policy } : { mode, policy, variant: answering.policy.id };
  }

  /**
   * Serve later decisions from `next` and drop cached answers, which belong to the old model.
   * Stopping the old engine is the caller's job; decisions already queued on it fail open.
   */
  replaceEngine(next: Engine): Engine {
    const previous = this.#engine;
    this.#engine = next;
    this.#queue.setConcurrency(next.concurrency);
    this.#service.clear();
    this.#generation += 1;
    this.#cache.clear();
    this.#inflight.clear();
    return previous;
  }

  /** Decisions in the engine queue or waiting for the engine to load. */
  get queueDepth(): number {
    return this.#queue.depth + this.#preparing;
  }

  /** Engine calls that run at once, from the engine's own setting. */
  get slots(): number {
    return this.#queue.concurrency;
  }

  latency(p: number): number | undefined {
    return this.#latency.percentile(p);
  }

  /**
   * Pass-through `/v1/systemone`: keys sorted, strings redacted. Admitted like a decision (same
   * queue limits, priority `low`) and reported to the failure and success handlers; a full or
   * busy engine throws `EngineBusyError` (503). Never cached or logged: the payload is the
   * caller's.
   */
  async systemOne(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    this.#assertCurrent(this.#generation);
    const generation = this.#generation;
    const engine = this.#engine;
    const clean = sortKeysDeep(redactDeep(request));
    const started = performance.now();
    const bounded = this.#signal(signal);
    try {
      const response = await this.#queue.run(
        bounded,
        () => {
          this.#assertCurrent(generation);
          return this.#timed(() => this.#engine.decide(clean, bounded), bounded);
        },
        PASS_THROUGH_PRIORITY,
        queueLimits(this.slots),
      );
      this.#latency.add(performance.now() - started);
      this.#successHandler?.(engine);
      return response;
    } catch (error) {
      throw this.#passThroughFailure(error, engine, signal);
    }
  }

  /** Map a pass-through error: queue full and busy become 503s, others reach the handler. */
  #passThroughFailure(error: unknown, engine: Engine, caller: AbortSignal): unknown {
    if (error instanceof QueueFullError) {
      return new EngineBusyError('engine queue full');
    }
    if (isEngineBusy(error)) {
      return new EngineBusyError(ENGINE_BUSY_ERROR);
    }
    if (error instanceof EngineBusyError) {
      return error;
    }
    if (!caller.aborted) {
      // A caller that hung up is not an engine failure (a timeout is: it fires `bounded` only).
      this.#failureHandler?.(engine);
    }
    return error;
  }

  async decide(
    policyId: string,
    request: DecideRequest,
    signal: AbortSignal,
  ): Promise<DecideResponse> {
    const { policy, mode, variant } = this.#resolve(policyId, request.scope);
    const decisionId = randomUUID();
    const base = {
      decisionId,
      policy: policyId,
      ...(variant === undefined ? {} : { variant }),
      mode,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      engine: this.#engine.id,
      model: this.#engine.model,
    };
    if (mode === 'off') {
      this.#noteCall(request, policyId, {
        decisionId,
        action: 'abstain',
        enforced: false,
        answered: false,
      });
      return {
        ...base,
        action: 'abstain',
        enforced: false,
        answers: {},
        rule: -1,
        latencyMs: 0,
        cached: false,
      };
    }
    const input = redactDeep(request.input);
    const precedent = this.#precedentFor(policy, input, request.workspace?.cwd);
    const { state, questions, hash, truncated, criticalCut } = this.#state(policy, input);
    const admitted = admission(mode, policy, signal, request.budgetMs);
    const result = await this.#answers(
      { state, questions },
      hash,
      policy.cache.ttlSeconds,
      admitted,
    );
    // Cached answers are stored without this: the guard runs on every call, hits included.
    const match = guardTruncation(
      evaluateRules(policy, result.answers, { precedentAllows: precedent?.allows ?? false }),
      criticalCut,
    );
    const enforced = mode === 'act' && result.error === undefined;
    const response: DecideResponse = {
      ...base,
      action: match.action,
      enforced,
      answers: result.answers,
      rule: match.rule,
      latencyMs: result.latencyMs,
      cached: result.cached,
      ...(precedent === undefined
        ? {}
        : { precedentKey: precedent.key, precedent: precedent.tally }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(truncated.length === 0 ? {} : { truncated }),
    };
    this.#record(request, response, {
      hash,
      stateTokens: Math.ceil(state.length / CHARS_PER_TOKEN),
      ...(result.queueMs === undefined ? {} : { queueMs: result.queueMs }),
      ...(result.engineMs === undefined ? {} : { engineMs: result.engineMs }),
    });
    this.#noteCall(request, policyId, {
      decisionId,
      action: response.action,
      enforced: response.enforced,
      answered: response.error === undefined,
    });
    return response;
  }

  /** What the model reads for `input` (redacted), the questions, their hash and what was cut. */
  #state(
    policy: Policy,
    input: Readonly<Record<string, unknown>>,
  ): BuiltState & { questions: Questions; hash: string; state: string } {
    const modelInput = { ...input };
    delete modelInput['subject'];
    if (policy.precedent !== undefined) {
      delete modelInput[policy.precedent.from];
    }
    const built = buildState(
      policySections(policy, modelInput, renderValue),
      policy.state.maxTokens,
    );
    const state = built.text;
    const questions = sortKeysDeep(policyQuestions(policy));
    const hash = inputHash({ id: policy.id, version: policy.version, state, questions });
    return { ...built, state, questions, hash };
  }

  /** Index the decision under the request's call id, even if its HTTP caller is gone. */
  #noteCall(request: DecideRequest, policyId: string, decision: CallDecision): void {
    if (request.call !== undefined) {
      this.calls.note(request.call.id, policyId, decision, request.call.permissionMode);
    }
  }

  #precedentFor(
    policy: Policy,
    input: Readonly<Record<string, unknown>>,
    cwd?: string,
  ): PrecedentDecision | undefined {
    const settings = policy.precedent;
    if (settings === undefined || cwd === undefined || cwd.trim() === '') {
      return undefined;
    }
    const subject = renderValue(input[settings.from]);
    if (subject === '') {
      return undefined;
    }
    const key = inputHash(['v2', policy.id, `/${resolveSegments('', cwd).join('/')}`, subject]);
    const tally = this.#precedent.tally(key);
    return {
      key,
      tally,
      allows: tally.allows >= settings.minAllows && tally.denies === 0,
    };
  }

  async #answers(
    request: SystemOneRequest,
    hash: string,
    ttlSeconds: number,
    admitted: Admission,
  ): Promise<EngineResult> {
    const { signal, priority, budgetMs } = admitted;
    const blocked = this.#blocked;
    if (blocked !== null) {
      return { answers: {}, latencyMs: 0, cached: false, error: blocked };
    }
    const hit = this.#cache.get(hash);
    if (hit !== undefined && hit.expires > Date.now()) {
      return { answers: hit.answers, latencyMs: 0, cached: true };
    }
    const running = ttlSeconds <= 0 ? undefined : this.#inflight.get(hash);
    // The queue cannot re-prioritise a running call: a more urgent request runs on its own.
    if (running !== undefined && PRIORITY_RANK[priority] <= PRIORITY_RANK[running.priority]) {
      return this.#join(running, signal);
    }
    const busy = this.#overBudget(budgetMs);
    if (busy !== undefined) {
      return busy;
    }
    if (ttlSeconds <= 0 || running !== undefined) {
      return this.#compute(request, hash, ttlSeconds, signal, priority);
    }
    // The shared call has its own signal: it aborts only once every waiter has left.
    const controller = new AbortController();
    const call: SharedCall = {
      hash,
      priority,
      controller,
      waiters: 0,
      promise: this.#compute(request, hash, ttlSeconds, controller.signal, priority).finally(() => {
        if (this.#inflight.get(hash) === call) {
          this.#inflight.delete(hash);
        }
      }),
    };
    this.#inflight.set(hash, call);
    return this.#join(call, signal);
  }

  /**
   * Refuse a request whose caller will not wait out the estimated queue time, before it takes a
   * place: the same fail-open result as the engine's own 503, not an engine failure.
   */
  #overBudget(budgetMs: number | undefined): EngineResult | undefined {
    if (budgetMs === undefined) {
      return undefined;
    }
    const wait = estimateWaitMs(this.queueDepth, this.slots, this.#service.mean());
    return wait > budgetMs
      ? { answers: {}, latencyMs: 0, cached: false, error: ENGINE_BUSY_ERROR }
      : undefined;
  }

  /** Wait for a shared call; return early (not abort it) when this caller's signal fires. */
  async #join(call: SharedCall, signal: AbortSignal): Promise<EngineResult> {
    call.waiters += 1;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<EngineResult>((resolve) => {
      onAbort = (): void => {
        call.waiters -= 1;
        if (call.waiters === 0) {
          // Unlist it now: a newcomer must not join a call that is already aborted.
          if (this.#inflight.get(call.hash) === call) {
            this.#inflight.delete(call.hash);
          }
          call.controller.abort(signal.reason);
        }
        resolve({
          answers: {},
          latencyMs: 0,
          cached: false,
          error: errorMessage(signal.reason),
        });
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([call.promise, aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async #compute(
    request: SystemOneRequest,
    hash: string,
    ttlSeconds: number,
    signal: AbortSignal,
    priority: Priority,
  ): Promise<EngineResult> {
    // A managed engine (ensureReady) loads on demand, outside the queue; others must be up.
    const engine = this.#engine;
    const generation = this.#generation;
    if (engine.ensureReady === undefined && engine.health().state !== 'ready') {
      return { answers: {}, latencyMs: 0, cached: false, error: `engine ${engine.health().state}` };
    }
    const started = performance.now();
    const timing: { jobStarted?: number; engineMs?: number } = {};
    try {
      const bounded = this.#signal(signal);
      if (engine.ensureReady !== undefined && engine.health().state !== 'ready') {
        await this.#prepare(engine, bounded, priority);
      }
      // The job reads this.#engine: after replaceEngine during the load, the new engine answers
      // (loading inside the slot if cold) and the handlers below still name `engine`. Intended:
      // decisions in flight on a replaced engine only need to fail open. Likewise, if the engine
      // unloads between #prepare and the job, ManagedEngine.decide loads inside the slot (rare;
      // the old behaviour).
      const response = await this.#queue.run(
        bounded,
        () => {
          this.#assertCurrent(generation);
          timing.jobStarted = performance.now();
          return this.#timed(
            () => this.#engine.decide(request, bounded),
            bounded,
            (ms) => {
              timing.engineMs = ms;
            },
          );
        },
        priority,
        queueLimits(this.slots),
      );
      const answers = normaliseAnswers(request.questions, response);
      const latencyMs = performance.now() - started;
      this.#latency.add(latencyMs);
      const timings = engineTimings(started, timing);
      if (Object.keys(answers).length === 0) {
        return {
          answers,
          latencyMs,
          cached: false,
          error: 'engine returned no usable answers',
          ...timings,
        };
      }
      if (generation === this.#generation) {
        this.#remember(hash, answers, ttlSeconds);
      }
      this.#successHandler?.(engine);
      return { answers, latencyMs, cached: false, ...timings };
    } catch (error) {
      return this.#failed(error, engine, started, signal);
    }
  }

  /**
   * Run an engine call, adding its duration to the service window when it answers or when its
   * signal fires (timeout or caller abort, so a hanging engine raises the mean). Immediate
   * non-abort errors are not sampled. At most one sample per call.
   */
  async #timed<T>(
    call: () => Promise<T>,
    signal: AbortSignal,
    onDone?: (ms: number) => void,
  ): Promise<T> {
    const started = performance.now();
    let recorded = false;
    const record = (): void => {
      if (!recorded) {
        recorded = true;
        this.#service.add(performance.now() - started);
      }
    };
    signal.addEventListener('abort', record, { once: true });
    try {
      const result = await call();
      record();
      return result;
    } finally {
      signal.removeEventListener('abort', record);
      onDone?.(performance.now() - started);
    }
  }

  /**
   * Wait for a managed engine to load before taking a queue slot, so a cold load blocks no one.
   * Waiters count toward queueDepth and the same limits as the queue; `high` ones are never
   * refused here (they evict a waiting `low` once the engine is ready).
   */
  async #prepare(engine: Engine, signal: AbortSignal, priority: Priority): Promise<void> {
    // Checked apart from the queue's limits: a burst that finishes a cold load is re-checked by
    // the queue itself, and `high` waiting for the load is bounded only by decisionTimeoutMs.
    if (
      priority !== 'high' &&
      this.queueDepth >= admissionLimit(priority, queueLimits(this.slots))
    ) {
      throw new QueueFullError();
    }
    this.#preparing += 1;
    try {
      await engine.ensureReady?.(signal);
    } finally {
      this.#preparing -= 1;
    }
  }

  /**
   * A full queue is not an engine failure: no failure handler, and `latencyMs: 0` even for a
   * decision evicted after waiting (kept out of latency stats on purpose).
   */
  #failed(error: unknown, engine: Engine, started: number, caller: AbortSignal): EngineResult {
    if (error instanceof QueueFullError) {
      return { answers: {}, latencyMs: 0, cached: false, error: 'engine queue full' };
    }
    if (isEngineBusy(error)) {
      // Transient load (the engine's queue timeout): fail open, but not an engine failure.
      return {
        answers: {},
        latencyMs: performance.now() - started,
        cached: false,
        error: ENGINE_BUSY_ERROR,
      };
    }
    if (!caller.aborted) {
      // A caller that hung up is not an engine failure; a decision timeout (bounded signal) is.
      this.#failureHandler?.(engine);
    }
    return {
      answers: {},
      latencyMs: performance.now() - started,
      cached: false,
      error: errorMessage(error),
    };
  }

  #remember(hash: string, answers: Answers, ttlSeconds: number): void {
    if (ttlSeconds <= 0) {
      return;
    }
    if (this.#cache.size >= CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) {
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(hash, { answers, expires: Date.now() + ttlSeconds * 1000 });
  }

  #signal(caller: AbortSignal): AbortSignal {
    return AbortSignal.any([caller, AbortSignal.timeout(this.#timeoutMs)]);
  }

  #record(
    request: DecideRequest,
    response: DecideResponse,
    state: { hash: string; stateTokens: number; queueMs?: number; engineMs?: number },
  ): void {
    const record: ShadowRecord = {
      kind: 'decision',
      ts: this.#now().toISOString(),
      decisionId: response.decisionId,
      harness: request.harness,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      policy: response.policy,
      ...(response.variant === undefined ? {} : { variant: response.variant }),
      mode: response.mode,
      ...callFields(request),
      inputHash: state.hash,
      ...(response.precedentKey === undefined ? {} : { precedentKey: response.precedentKey }),
      ...(response.precedent === undefined ? {} : { precedent: response.precedent }),
      stateTokens: state.stateTokens,
      ...modelFields(request, response.action),
      answers: response.answers,
      action: response.action,
      enforced: response.enforced,
      engine: response.engine,
      model: response.model,
      latencyMs: Math.round(response.latencyMs),
      ...(state.queueMs === undefined ? {} : { queueMs: Math.round(state.queueMs) }),
      ...(state.engineMs === undefined ? {} : { engineMs: Math.round(state.engineMs) }),
      ...(response.error === undefined ? {} : { error: response.error }),
      ...(response.truncated === undefined ? {} : { truncated: response.truncated }),
    };
    this.#log.append(record);
    this.#precedent.noteDecision(record);
  }
}

/** Queue wait and engine time of a call that ran; empty when the job never started. */
function engineTimings(
  started: number,
  timing: { jobStarted?: number; engineMs?: number },
): { queueMs?: number; engineMs?: number } {
  const { jobStarted, engineMs } = timing;
  return {
    ...(jobStarted === undefined ? {} : { queueMs: Math.max(0, jobStarted - started) }),
    ...(engineMs === undefined ? {} : { engineMs }),
  };
}

/**
 * Nobody acts on a shadow decision, so it outlives a caller that gave up (a hook's 1.5 s budget
 * is shorter than a CPU decision), is still logged within decisionTimeoutMs, and yields to
 * decisions someone waits on.
 */
function admission(
  mode: Mode,
  policy: Policy,
  signal: AbortSignal,
  budgetMs: number | undefined,
): Admission {
  // A shadow decision has no caller waiting, so a budget never refuses it.
  return mode === 'shadow'
    ? { signal: new AbortController().signal, priority: 'low' }
    : { signal, priority: policy.priority, ...(budgetMs === undefined ? {} : { budgetMs }) };
}

/** `scope`, `callId`, `permissionMode` and `subagent`, from the request's `scope` and `call`. */
function callFields(
  request: DecideRequest,
): Pick<ShadowRecord, 'scope' | 'callId' | 'permissionMode' | 'subagent'> {
  const { call, scope } = request;
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(call === undefined ? {} : { callId: call.id }),
    ...(call?.permissionMode === undefined ? {} : { permissionMode: call.permissionMode }),
    ...(call?.agent === undefined ? {} : { subagent: call.agent }),
  };
}

/** `requestedModel` and the model `action` routes to, from the request's `models`. */
function modelFields(
  request: DecideRequest,
  action: string,
): { requestedModel?: string; routedModel?: string } {
  const requested = request.models?.requested;
  const routed = request.models?.routes?.[action];
  return {
    ...(requested === undefined ? {} : { requestedModel: requested }),
    ...(routed === undefined ? {} : { routedModel: routed }),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'decision timed out';
  }
  return error instanceof Error ? error.message : String(error);
}
