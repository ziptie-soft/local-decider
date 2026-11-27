import {
  parsePolicy,
  type DecideRequest,
  type DecideResponse,
  type Mode,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Decider, GLOBAL_QUEUE_MAX } from '../src/decider.ts';
import { laneKey, PRIMARY_LANE, type PolicyRoute } from '../src/engine-lane.ts';
import { ManagedEngine } from '../src/engines/lazy.ts';
import { ENGINE_BUSY_ERROR } from '../src/engines/types.ts';
import type { LoadedPolicy } from '../src/policies.ts';
import { FakeEngine, tempLog } from './helpers.ts';

/** The repository's policies: the gateway's build copy can lag behind them. */
const POLICIES = fileURLToPath(new URL('../../../policies/', import.meta.url));
const POLICY_FILES = ['permission', 'command-risk', 'command-risk-binary'] as const;
const PROBS = { allow: 1, safe: 1 };
const SWITCHING = 'engine switching';

function loadPolicies(mode: Mode, ttlSeconds: number): Map<string, LoadedPolicy> {
  const loaded = new Map<string, LoadedPolicy>();
  for (const name of POLICY_FILES) {
    const source = join(POLICIES, `${name}.yaml`);
    const policy = parsePolicy(readFileSync(source, 'utf8'));
    loaded.set(policy.id, { policy: { ...policy, cache: { ttlSeconds } }, mode, source });
  }
  return loaded;
}

function named(id: string, model: string, probs: Record<string, number> = PROBS): FakeEngine {
  return Object.assign(new FakeEngine(probs), { id, model });
}

/** A fake that answers after `ms` milliseconds. */
function slow(fake: FakeEngine, ms: number): FakeEngine {
  const inner = fake.respond;
  fake.respond = async (request, signal) => {
    await sleep(ms);
    return inner(request, signal);
  };
  return fake;
}

/** A fake whose answers wait for `release()`. */
function gated(fake: FakeEngine): { fake: FakeEngine; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const inner = fake.respond;
  fake.respond = async (request, signal) => {
    await promise;
    return inner(request, signal);
  };
  return { fake, release: resolve };
}

function managed(fake: FakeEngine): ManagedEngine {
  return new ManagedEngine(fake, { lifecycle: 'lazy', idleUnloadMinutes: 10 });
}

function route(
  lane: string | null,
  source: PolicyRoute['source'],
  fake: FakeEngine,
  extra: Partial<PolicyRoute> = {},
): PolicyRoute {
  return {
    laneKey: lane,
    source,
    fallback: 'default',
    configured: { engine: 'llama-vulkan', model: fake.model },
    ...extra,
  };
}

interface Setup {
  readonly decider: Decider;
  readonly primary: FakeEngine;
}

function setup(options: { ttl?: number; mode?: Mode; drainMs?: number } = {}): Setup {
  const primary = named('primary-engine', 'primary-model');
  const decider = new Decider({
    engine: primary,
    policies: loadPolicies(options.mode ?? 'act', options.ttl ?? 0),
    log: tempLog(),
    decisionTimeoutMs: 2000,
    laneDrainMs: options.drainMs ?? 2000,
  });
  return { decider, primary };
}

function decideRequest(n = 0, budgetMs?: number): DecideRequest {
  return {
    harness: 'claude-code',
    input: {
      project: '/p',
      tool: 'Bash',
      command: `echo ${String(n)}`,
      request: { command: `echo ${String(n)}` },
      history: `user: ${String(n)}`,
    },
    ...(budgetMs === undefined ? {} : { budgetMs }),
  };
}

const signal = (): AbortSignal => new AbortController().signal;

function decide(
  decider: Decider,
  policy: string,
  n = 0,
  budgetMs?: number,
): Promise<DecideResponse> {
  return decider.decide(policy, decideRequest(n, budgetMs), signal());
}

function routes(entries: Record<string, PolicyRoute>): ReadonlyMap<string, PolicyRoute> {
  return new Map(Object.entries(entries));
}

describe('Decider lanes: routing', () => {
  it('answers from the primary with modelSource default when no route is set', async () => {
    const { decider, primary } = setup();
    const response = await decide(decider, 'command-risk');
    assert.equal(response.engine, 'primary-engine');
    assert.equal(response.model, 'primary-model');
    assert.equal(response.modelSource, 'default');
    assert.equal(primary.requests.length, 1);
    assert.deepEqual(
      decider.laneStats().map((s) => s.key),
      [PRIMARY_LANE],
    );
  });

  it('routes a policy to its lane and keeps the lane cache apart from the primary', async () => {
    const { decider, primary } = setup({ ttl: 60 });
    const own = named('llama-vulkan', 'own-model');
    const key = laneKey('llama-vulkan', 'own-model');
    decider.installLane(key, managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route(key, 'policy', own) }));
    const first = await decide(decider, 'command-risk');
    assert.equal(first.engine, 'llama-vulkan');
    assert.equal(first.model, 'own-model');
    assert.equal(first.modelSource, 'policy');
    assert.equal((await decide(decider, 'command-risk')).cached, true);
    assert.equal(own.requests.length, 1);
    // Another policy still uses the primary.
    assert.equal((await decide(decider, 'permission')).modelSource, 'default');
    // The same decision on the primary is not served from the lane's cache entry.
    decider.setPolicyRoutes(routes({}));
    const onPrimary = await decide(decider, 'command-risk');
    assert.equal(onPrimary.cached, false);
    assert.equal(onPrimary.engine, 'primary-engine');
    assert.equal(primary.requests.length, 2);
  });

  it('lets a variant route win over the base, and the base route serve a variant without one', async () => {
    const { decider } = setup();
    const base = named('llama-vulkan', 'base-model');
    const variant = named('llama-vulkan', 'variant-model');
    decider.installLane('base', managed(base));
    decider.installLane('variant', managed(variant));
    assert.equal(decider.setVariant('command-risk', 'command-risk-binary'), true);
    decider.setPolicyRoutes(
      routes({
        'command-risk': route('base', 'policy', base),
        'command-risk-binary': route('variant', 'policy', variant),
      }),
    );
    const own = await decide(decider, 'command-risk');
    assert.equal(own.variant, 'command-risk-binary');
    assert.equal(own.model, 'variant-model');
    decider.setPolicyRoutes(routes({ 'command-risk': route('base', 'policy', base) }));
    const inherited = await decide(decider, 'command-risk');
    assert.equal(inherited.variant, 'command-risk-binary');
    assert.equal(inherited.model, 'base-model');
    assert.deepEqual(decider.engineOf('command-risk'), {
      engine: 'llama-vulkan',
      model: 'base-model',
      source: 'policy',
    });
  });

  it('fails an unavailable route open with the configured model and no answers', async () => {
    const { decider, primary } = setup();
    const missing = named('lmstudio', 'qwen3-4b');
    decider.setPolicyRoutes(
      routes({
        'command-risk': route(null, 'unavailable', missing, {
          fallback: 'open',
          reason: 'not installed',
          configured: { engine: 'lmstudio', model: 'qwen3-4b' },
        }),
      }),
    );
    const response = await decide(decider, 'command-risk');
    assert.equal(response.modelSource, 'unavailable');
    assert.equal(response.engine, 'lmstudio');
    assert.equal(response.model, 'qwen3-4b');
    assert.deepEqual(response.answers, {});
    assert.equal(response.error, 'policy model unavailable: not installed');
    assert.equal(response.enforced, false);
    assert.equal(response.action, 'ask');
    assert.equal(response.rule, -1);
    assert.equal(primary.requests.length, 0);
    assert.equal(decider.engineOf('command-risk')?.source, 'unavailable');
  });

  it('answers an unavailable override with the primary as a fallback', async () => {
    const { decider, primary } = setup();
    decider.setPolicyRoutes(
      routes({
        'command-risk': route(PRIMARY_LANE, 'fallback', primary, { reason: 'not installed' }),
      }),
    );
    const response = await decide(decider, 'command-risk');
    assert.equal(response.modelSource, 'fallback');
    assert.equal(response.engine, 'primary-engine');
    assert.equal(response.error, undefined);
    assert.equal(primary.requests.length, 1);
  });

  it('treats a route whose lane is missing as fallback, or unavailable when fallback is open', async () => {
    const { decider } = setup();
    const gone = named('llama-vulkan', 'gone-model');
    decider.setPolicyRoutes(routes({ 'command-risk': route('gone', 'policy', gone) }));
    assert.equal((await decide(decider, 'command-risk')).modelSource, 'fallback');
    decider.setPolicyRoutes(
      routes({ 'command-risk': route('gone', 'policy', gone, { fallback: 'open' }) }),
    );
    const response = await decide(decider, 'command-risk');
    assert.equal(response.modelSource, 'unavailable');
    assert.match(response.error ?? '', /^policy model unavailable/);
  });

  it('reports no model source for a policy that is off', async () => {
    const { decider } = setup();
    decider.setMode('command-risk', 'off');
    const response = await decide(decider, 'command-risk');
    assert.equal(response.modelSource, undefined);
    assert.equal(response.engine, 'primary-engine');
  });

  it('keeps systemOne on the primary', async () => {
    const { decider, primary } = setup();
    const own = named('llama-vulkan', 'own-model');
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    await decider.systemOne({ questions: {}, state: 'x' }, signal());
    assert.equal(primary.requests.length, 1);
    assert.equal(own.requests.length, 0);
  });

  it('refuses to install a lane twice or to retire the primary', async () => {
    const { decider } = setup();
    decider.installLane('own', managed(named('llama-vulkan', 'own-model')));
    assert.throws(() => {
      decider.installLane('own', managed(named('llama-vulkan', 'own-model')));
    }, /already installed/);
    assert.throws(() => {
      decider.installLane(PRIMARY_LANE, managed(named('llama-vulkan', 'own-model')));
    }, /already installed/);
    await assert.rejects(decider.retireLane(PRIMARY_LANE, SWITCHING), /replaced, not retired/);
    await decider.retireLane('unknown', SWITCHING);
  });
});

describe('Decider lanes: isolation and admission', () => {
  it('does not let a slow lane delay a primary decision', async () => {
    const { decider } = setup();
    const own = slow(named('llama-vulkan', 'own-model'), 300);
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const slowOne = decide(decider, 'command-risk');
    const started = performance.now();
    const fast = await decide(decider, 'permission');
    assert.equal(fast.error, undefined);
    assert.ok(performance.now() - started < 200);
    assert.equal((await slowOne).modelSource, 'policy');
  });

  it('refuses a decision for a saturated lane as busy while the primary admits', async () => {
    const { decider } = setup({ mode: 'shadow' });
    const own = slow(named('llama-vulkan', 'own-model'), 100);
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    await decide(decider, 'command-risk', 0); // times the lane: about 100 ms per decision
    const fillers = [1, 2, 3].map((n) => decide(decider, 'command-risk', n));
    decider.setMode('command-risk', 'act');
    decider.setMode('permission', 'act');
    const refused = await decide(decider, 'command-risk', 4, 100);
    assert.equal(refused.error, ENGINE_BUSY_ERROR);
    assert.equal(refused.modelSource, 'policy');
    const admitted = await decide(decider, 'permission', 5, 100);
    assert.equal(admitted.error, undefined);
    await Promise.all(fillers);
  });

  it('refuses the 17th admission across two lanes as busy', async () => {
    const { decider } = setup({ mode: 'shadow' });
    const { fake: a, release: releaseA } = gated(named('llama-vulkan', 'model-a'));
    const { fake: b, release: releaseB } = gated(named('llama-vulkan', 'model-b'));
    // Four slots each: the lanes' own limits (11) are above 8, so only the global cap can refuse.
    a.concurrency = 4;
    b.concurrency = 4;
    decider.installLane('a', managed(a));
    decider.installLane('b', managed(b));
    decider.setPolicyRoutes(
      routes({ 'permission': route('a', 'policy', a), 'command-risk': route('b', 'policy', b) }),
    );
    const held: Promise<DecideResponse>[] = [];
    for (let n = 0; n < GLOBAL_QUEUE_MAX / 2; n++) {
      held.push(decide(decider, 'permission', n), decide(decider, 'command-risk', n));
    }
    assert.equal(decider.queueDepth, GLOBAL_QUEUE_MAX);
    const refused = await decide(decider, 'permission', 99);
    assert.equal(refused.error, ENGINE_BUSY_ERROR);
    assert.equal(a.requests.length + b.requests.length, 8);
    releaseA();
    releaseB();
    const settled = await Promise.all(held);
    assert.ok(settled.every((r) => r.error === undefined));
    assert.equal(decider.queueDepth, 0);
  });

  it('accepts a high decision while low ones fill the global cap on another lane', async () => {
    const { decider } = setup({ mode: 'shadow' });
    const { fake: a, release: releaseA } = gated(named('llama-vulkan', 'model-a'));
    const { fake: b, release: releaseB } = gated(named('llama-vulkan', 'model-b'));
    a.concurrency = 4;
    b.concurrency = 4;
    decider.installLane('a', managed(a));
    decider.installLane('b', managed(b));
    decider.setPolicyRoutes(
      routes({ 'permission': route('a', 'policy', a), 'command-risk': route('b', 'policy', b) }),
    );
    // Shadow decisions are `low`: eight on each lane fill the global cap.
    const held: Promise<DecideResponse>[] = [];
    for (let n = 0; n < GLOBAL_QUEUE_MAX / 2; n++) {
      held.push(decide(decider, 'permission', n), decide(decider, 'command-risk', n));
    }
    assert.equal(decider.queueDepth, GLOBAL_QUEUE_MAX);
    assert.equal((await decide(decider, 'permission', 98)).error, ENGINE_BUSY_ERROR);
    // `permission` is a `high` policy: in act mode it may use the reserve beyond the cap.
    decider.setMode('permission', 'act');
    held.push(decide(decider, 'permission', 99));
    assert.equal(decider.queueDepth, GLOBAL_QUEUE_MAX + 1);
    releaseA();
    releaseB();
    const settled = await Promise.all(held);
    assert.equal(settled.at(-1)?.error, undefined);
    assert.equal(decider.queueDepth, 0);
  });

  it('keeps lane failures away from the failure and success handlers', async () => {
    const { decider, primary } = setup();
    const own = named('llama-vulkan', 'own-model');
    own.respond = () => Promise.reject(new Error('boom'));
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const failed = mock.fn();
    const succeeded = mock.fn();
    decider.onEngineFailure(failed);
    decider.onEngineSuccess(succeeded);
    const lane = await decide(decider, 'command-risk');
    assert.equal(lane.error, 'boom');
    assert.equal(lane.modelSource, 'policy');
    assert.equal(failed.mock.callCount(), 0);
    await decide(decider, 'permission');
    assert.equal(succeeded.mock.callCount(), 1);
    primary.respond = () => Promise.reject(new Error('boom'));
    await decide(decider, 'permission', 1);
    assert.equal(failed.mock.callCount(), 1);
  });

  it('aggregates engine counters and reports stats for every lane in service', async () => {
    const { decider, primary } = setup();
    const own = named('llama-vulkan', 'own-model');
    primary.counters = () => ({ engineRestarts: 1, engineHangs: 0 });
    own.counters = () => ({ engineRestarts: 2, engineHangs: 3 });
    decider.installLane('own', managed(own));
    assert.equal(decider.counters().engineRestarts, 3);
    assert.equal(decider.counters().engineHangs, 3);
    const [first, second] = decider.laneStats();
    assert.equal(first?.key, PRIMARY_LANE);
    assert.equal(second?.key, 'own');
    assert.deepEqual(second?.counters, { engineRestarts: 2, engineHangs: 3 });
    await decider.retireLane('own', SWITCHING);
    // A retired lane's totals stay in the sum.
    assert.equal(decider.counters().engineRestarts, 3);
    assert.equal(decider.laneStats().length, 1);
  });
});

describe('Decider lanes: retiring', () => {
  it('fails a call waiting for a cold load open and never calls the retired engine', async () => {
    const { decider, primary } = setup();
    const own = named('llama-vulkan', 'own-model');
    own.state = 'stopped';
    const { promise: loading, resolve: finishLoad } = Promise.withResolvers<void>();
    own.start = async (): Promise<void> => {
      await loading;
      own.state = 'ready';
    };
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const waiting = decide(decider, 'command-risk');
    await sleep(10);
    const retiring = decider.retireLane('own', SWITCHING);
    // Only the lane changed: the primary is not held and keeps answering.
    assert.equal(decider.held, null);
    assert.equal((await decide(decider, 'permission')).error, undefined);
    finishLoad();
    const result = await waiting;
    await retiring;
    assert.equal(result.error, SWITCHING);
    assert.equal(own.requests.length, 0);
    assert.equal(own.state, 'stopped');
    assert.equal(primary.requests.length, 1);
  });

  it('fails a queued call open and lets the active call finish before retiring', async () => {
    const { decider, primary } = setup();
    const own = slow(named('llama-vulkan', 'own-model'), 80);
    const engine = managed(own);
    const retire = mock.method(engine, 'retire');
    decider.installLane('own', engine);
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const active = decide(decider, 'command-risk', 1);
    const queued = decide(decider, 'command-risk', 2);
    await sleep(10);
    const retiring = decider.retireLane('own', SWITCHING);
    let retired = false;
    void retiring.then(() => {
      retired = true;
    });
    await sleep(20);
    assert.equal(retired, false, 'retire waits for the active call');
    assert.equal(retire.mock.callCount(), 0);
    // The lane being retired no longer counts toward the gateway's depth.
    assert.equal(decider.queueDepth, 0);
    assert.equal((await decide(decider, 'permission')).error, undefined);
    const [done, failed] = await Promise.all([active, queued]);
    await retiring;
    assert.equal(done.error, undefined);
    assert.equal(failed.error, SWITCHING);
    assert.equal(own.requests.length, 1);
    assert.equal(retire.mock.callCount(), 1);
    assert.equal(primary.requests.length, 1);
    // The route stays until the planner replaces it: never the default model's own answer.
    assert.equal(decider.engineOf('command-risk')?.source, 'fallback');
  });

  it('gives up waiting for a call that outlasts the drain bound', async () => {
    const { decider } = setup({ drainMs: 40 });
    const own = slow(named('llama-vulkan', 'own-model'), 400);
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const running = decide(decider, 'command-risk');
    await sleep(10);
    const started = performance.now();
    await decider.retireLane('own', SWITCHING);
    assert.ok(performance.now() - started < 300);
    assert.equal(own.state, 'stopped');
    await running;
  });

  it('never caches an answer that finishes after its lane was retired', async () => {
    const { decider } = setup({ ttl: 60, drainMs: 20 });
    const old = slow(named('llama-vulkan', 'own-model'), 120);
    decider.installLane('own', managed(old));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', old) }));
    const running = decide(decider, 'command-risk');
    await sleep(10);
    await decider.retireLane('own', SWITCHING);
    assert.equal((await running).error, undefined, 'the active call still answered');
    // The same model comes back on a fresh lane (same cache key): the late answer is not there.
    const fresh = named('llama-vulkan', 'own-model');
    decider.installLane('own', managed(fresh));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', fresh) }));
    const again = await decide(decider, 'command-risk');
    assert.equal(again.cached, false);
    assert.equal(fresh.requests.length, 1);
  });

  it('leaves the queued calls and the cache of other lanes alone', async () => {
    const { decider } = setup({ ttl: 60 });
    const a = named('llama-vulkan', 'model-a');
    const b = slow(named('llama-vulkan', 'model-b'), 60);
    decider.installLane('a', managed(a));
    decider.installLane('b', managed(b));
    decider.setPolicyRoutes(
      routes({ 'permission': route('a', 'policy', a), 'command-risk': route('b', 'policy', b) }),
    );
    await decide(decider, 'command-risk', 0);
    assert.equal(b.requests.length, 1);
    const running = decide(decider, 'command-risk', 1);
    const queued = decide(decider, 'command-risk', 2);
    await sleep(10);
    await decider.retireLane('a', SWITCHING);
    assert.equal(decider.engineOf('permission')?.source, 'fallback');
    const [first, second] = await Promise.all([running, queued]);
    assert.equal(first.error, undefined);
    assert.equal(second.error, undefined);
    assert.equal((await decide(decider, 'command-risk', 0)).cached, true);
    assert.equal(b.requests.length, 3);
  });

  it('answers as fallback from the primary while a lane drains when fallback is default', async () => {
    const { decider, primary } = setup();
    const own = slow(named('llama-vulkan', 'own-model'), 80);
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const active = decide(decider, 'command-risk', 1);
    await sleep(10);
    const retiring = decider.retireLane('own', SWITCHING);
    const during = await decide(decider, 'command-risk', 2);
    assert.equal(during.modelSource, 'fallback');
    assert.equal(during.engine, 'primary-engine');
    assert.equal(during.error, undefined);
    assert.equal(primary.requests.length, 1);
    await Promise.all([active, retiring]);
    // Lane gone, route kept: still never `default`.
    assert.equal((await decide(decider, 'command-risk', 3)).modelSource, 'fallback');
  });

  it('fails open as unavailable while a lane drains when fallback is open', async () => {
    const { decider, primary } = setup();
    const own = slow(named('llama-vulkan', 'own-model'), 80);
    decider.installLane('own', managed(own));
    decider.setPolicyRoutes(
      routes({ 'command-risk': route('own', 'policy', own, { fallback: 'open' }) }),
    );
    const active = decide(decider, 'command-risk', 1);
    await sleep(10);
    const retiring = decider.retireLane('own', SWITCHING);
    const during = await decide(decider, 'command-risk', 2);
    assert.equal(during.modelSource, 'unavailable');
    assert.equal(during.engine, 'llama-vulkan');
    assert.match(during.error ?? '', /^policy model unavailable/);
    assert.equal(primary.requests.length, 0);
    await Promise.all([active, retiring]);
    assert.equal((await decide(decider, 'command-risk', 3)).modelSource, 'unavailable');
    assert.equal(primary.requests.length, 0);
  });

  it('removes the lane even when retiring its engine throws, so the key can be reused', async () => {
    const { decider } = setup();
    const own = named('llama-vulkan', 'own-model');
    own.counters = () => ({ engineRestarts: 4, engineHangs: 0 });
    const engine = managed(own);
    mock.method(engine, 'retire', () => Promise.reject(new Error('retire failed')));
    decider.installLane('own', engine);
    await assert.rejects(decider.retireLane('own', SWITCHING), /retire failed/);
    assert.equal(decider.laneStats().length, 1);
    assert.equal(decider.counters().engineRestarts, 4, 'its totals were folded in');
    decider.installLane('own', managed(named('llama-vulkan', 'own-model')));
    assert.equal(decider.laneStats().length, 2);
  });

  it('returns the running retirement to a second retireLane for the same key', async () => {
    const { decider } = setup();
    const own = slow(named('llama-vulkan', 'own-model'), 60);
    const engine = managed(own);
    const retire = mock.method(engine, 'retire');
    decider.installLane('own', engine);
    decider.setPolicyRoutes(routes({ 'command-risk': route('own', 'policy', own) }));
    const active = decide(decider, 'command-risk');
    await sleep(10);
    const first = decider.retireLane('own', SWITCHING);
    const second = decider.retireLane('own', 'another reason');
    assert.equal(second, first);
    await Promise.all([first, second, active]);
    assert.equal(retire.mock.callCount(), 1);
    // Settled: a later call starts nothing (the lane is gone).
    await decider.retireLane('own', SWITCHING);
    assert.equal(retire.mock.callCount(), 1);
  });

  it('stops the primary and every lane', async () => {
    const { decider, primary } = setup();
    const a = named('llama-vulkan', 'model-a');
    const b = named('llama-vulkan', 'model-b');
    decider.installLane('a', managed(a));
    decider.installLane('b', managed(b));
    await decider.stopAll();
    assert.equal(primary.state, 'stopped');
    assert.equal(a.state, 'stopped');
    assert.equal(b.state, 'stopped');
  });
});
