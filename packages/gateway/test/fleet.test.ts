import { parsePolicy, type DecideRequest, type Mode } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StrandsEngineConfig } from '../src/config.ts';
import { Decider, estimateWaitMs, QUEUE_MAX } from '../src/decider.ts';
import { ManagedEngine } from '../src/engines/lazy.ts';
import { strandsEngine } from '../src/engines/strands/index.ts';
import { StrandsDeciderEngine } from '../src/engines/strands/server.ts';
import { ENGINE_BUSY_ERROR } from '../src/engines/types.ts';
import { defaultPolicyDir, type LoadedPolicy } from '../src/policies.ts';
import { SerialQueue } from '../src/queue.ts';
import { computeStats } from '../src/stats.ts';
import { FakeEngine, tempLog, tempPaths } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

function policies(mode: Mode): Map<string, LoadedPolicy> {
  const source = join(defaultPolicyDir(), 'permission.yaml');
  const policy = parsePolicy(readFileSync(source, 'utf8'));
  return new Map([
    ['permission', { policy: { ...policy, cache: { ttlSeconds: 0 } }, mode, source }],
  ]);
}

const INPUT = { project: '/p', tool: 'Bash', request: { command: 'ls' }, history: 'u' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const signal = (): AbortSignal => new AbortController().signal;

/** An engine that answers after `ms` and reports `concurrency` slots. */
function slowEngine(ms: number, concurrency?: number): FakeEngine {
  const engine = new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 });
  const answer = engine.respond;
  engine.concurrency = concurrency;
  engine.respond = async (req, sig) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return answer(req, sig);
  };
  return engine;
}

function deciderOn(engine: FakeEngine): Decider {
  return new Decider({
    engine,
    policies: policies('act'),
    log: tempLog(),
    decisionTimeoutMs: 5000,
  });
}

/** Distinct input per call so identical requests are not coalesced. */
const request = (n: number, budgetMs?: number): DecideRequest => ({
  harness: 'claude-code' as const,
  input: { ...INPUT, request: { command: `ls ${String(n)}` } },
  ...(budgetMs === undefined ? {} : { budgetMs }),
});

const strandsConfig = (extra: object): StrandsEngineConfig =>
  strandsEngine.configSchema.parse({ type: 'strands-decider', ...extra });

describe('queue slots follow engine concurrency', () => {
  it('reports the strands maxConcurrency, through the lifecycle wrapper', () => {
    const paths = tempPaths();
    const set = new StrandsDeciderEngine(strandsConfig({ maxConcurrency: 6 }), paths);
    assert.equal(set.concurrency, 6);
    assert.equal(new StrandsDeciderEngine(strandsConfig({}), paths).concurrency, undefined);
    const managed = new ManagedEngine(set, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    assert.equal(managed.concurrency, 6);
  });

  it('runs as many engine calls at once as the engine allows, default one', async () => {
    const wide = slowEngine(30, 3);
    const decider = deciderOn(wide);
    assert.equal(decider.slots, 3);
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => decider.decide('permission', request(n), signal())),
    );
    assert.equal(wide.maxInFlight, 3);

    const narrow = slowEngine(10);
    const serial = deciderOn(narrow);
    assert.equal(serial.slots, 1);
    await Promise.all([1, 2, 3].map((n) => serial.decide('permission', request(n), signal())));
    assert.equal(narrow.maxInFlight, 1);
  });

  it("takes the new engine's slots on replaceEngine", () => {
    const decider = deciderOn(slowEngine(1, 4));
    assert.equal(decider.slots, 4);
    decider.replaceEngine(slowEngine(1));
    assert.equal(decider.slots, 1);
  });

  it('SerialQueue honours concurrency and a later change', async () => {
    const queue = new SerialQueue({ concurrency: 2 });
    let running = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    };
    await Promise.all([1, 2, 3, 4].map(() => queue.run(signal(), job)));
    assert.equal(peak, 2);
    queue.setConcurrency(undefined);
    assert.equal(queue.concurrency, 1);
  });

  it('keeps room to wait beyond the slots', async () => {
    const engine = slowEngine(40, 4);
    const decider = deciderOn(engine);
    const sent = Array.from({ length: QUEUE_MAX + 5 }, (_, n) =>
      decider.decide('permission', request(n), signal()),
    );
    const results = await Promise.all(sent);
    // The permission policy is high priority: 7 waiting places beyond the 4 slots, 11 in all.
    assert.equal(results.filter((r) => r.error === 'engine queue full').length, 2);
  });
});

/** A decider whose engine answered once in about `ms`, now holding `held` more calls. */
async function loaded(
  ms: number,
  held: number,
): Promise<{ decider: Decider; done: () => Promise<void> }> {
  const engine = slowEngine(ms);
  const decider = deciderOn(engine);
  await decider.decide('permission', request(0), signal());
  const pending = Array.from({ length: held }, (_, n) =>
    decider.decide('permission', request(n + 1), signal()),
  );
  await flush();
  return { decider, done: async (): Promise<void> => void (await Promise.all(pending)) };
}

describe('budgetMs admission', () => {
  it('estimates the wait as full waves ahead times the mean service time', () => {
    assert.equal(estimateWaitMs(0, 1, 100), 0);
    assert.equal(estimateWaitMs(1, 2, 100), 0);
    assert.equal(estimateWaitMs(2, 2, 100), 100);
    assert.equal(estimateWaitMs(5, 1, 100), 500);
    assert.equal(estimateWaitMs(5, 1, undefined), 0);
  });

  it('refuses at once, fail open as busy, when the estimated wait exceeds the budget', async () => {
    const { decider, done } = await loaded(60, 3);
    const calls = decider.engine as FakeEngine;
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });
    const res = await decider.decide('permission', request(99, 20), signal());
    assert.equal(res.error, ENGINE_BUSY_ERROR);
    assert.deepEqual(res.answers, {});
    assert.equal(res.enforced, false);
    assert.notEqual(res.action, 'allow');
    assert.equal(res.latencyMs, 0);
    assert.equal(failures, 0, 'busy is not an engine failure');
    await done();
    assert.equal(calls.requests.length, 4, 'the refused request never reached the engine');
  });

  it("forgets the old engine's timings on replaceEngine", async () => {
    const { decider, done } = await loaded(60, 2);
    decider.replaceEngine(slowEngine(1));
    const res = await decider.decide('permission', request(99, 5), signal());
    assert.equal(res.error, undefined, 'no samples for the new engine: admitted');
    await done();
  });

  it('counts a call that hit its deadline, so a hanging engine raises the mean', async () => {
    const engine = slowEngine(1);
    engine.respond = (_request, sig) =>
      new Promise((_resolve, reject) => {
        sig.addEventListener('abort', () => reject(sig.reason as Error), { once: true });
      });
    const decider = new Decider({
      engine,
      policies: policies('act'),
      log: tempLog(),
      decisionTimeoutMs: 80,
    });
    const timedOut = await decider.decide('permission', request(0), signal());
    assert.ok(timedOut.error);
    const held = [1, 2].map((n) => decider.decide('permission', request(n), signal()));
    await flush();
    const res = await decider.decide('permission', request(9, 20), signal());
    assert.equal(res.error, ENGINE_BUSY_ERROR);
    await Promise.all(held);
  });

  it('accepts when the queue is empty, even with a tiny budget', async () => {
    const decider = deciderOn(slowEngine(30));
    await decider.decide('permission', request(0), signal());
    const res = await decider.decide('permission', request(1, 1), signal());
    assert.equal(res.error, undefined);
    assert.equal(res.action, 'allow');
  });

  it('accepts when the estimated wait fits the budget', async () => {
    const { decider, done } = await loaded(30, 1);
    const res = await decider.decide('permission', request(99, 10_000), signal());
    assert.equal(res.error, undefined);
    await done();
  });

  it('behaves as today without budgetMs', async () => {
    const { decider, done } = await loaded(30, 3);
    const res = await decider.decide('permission', request(99), signal());
    assert.equal(res.error, undefined);
    await done();
  });

  it('never refuses a shadow decision, which has no caller waiting', async () => {
    const engine = slowEngine(40);
    const decider = new Decider({
      engine,
      policies: policies('shadow'),
      log: tempLog(),
      decisionTimeoutMs: 5000,
    });
    await decider.decide('permission', request(0), signal());
    const pending = [1, 2].map((n) => decider.decide('permission', request(n), signal()));
    await flush();
    const res = await decider.decide('permission', request(9, 1), signal());
    assert.equal(res.error, undefined);
    await Promise.all(pending);
  });
});

describe('busy stats', () => {
  it('counts busy decisions apart and keeps them out of agreement', () => {
    const answers = {
      q: {
        type: 'choice' as const,
        answer: 'allow',
        probabilities: { allow: 0.9, ask: 0.1 },
        confidence: 0.9,
      },
    };
    const [stats] = computeStats([
      makeShadowRecord('busy', { error: ENGINE_BUSY_ERROR, answers }),
      makeShadowRecord('boom', { error: 'boom' }),
      makeShadowRecord('ok', { answers }),
      {
        kind: 'outcome',
        ts: 't',
        decisionId: 'busy',
        outcome: 'allow',
        source: 'user',
        verified: true,
      },
      {
        kind: 'outcome',
        ts: 't',
        decisionId: 'ok',
        outcome: 'allow',
        source: 'user',
        verified: true,
      },
    ]);
    assert.equal(stats?.busy, 1);
    assert.equal(stats.errors, 2);
    assert.equal(stats.labelled, 1, 'the busy decision is not labelled');
  });
});
