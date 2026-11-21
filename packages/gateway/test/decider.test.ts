import {
  canonicalSubject,
  parsePolicy,
  type LogRecord,
  type Mode,
  type SystemOneResponse,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Decider, QUEUE_MAX, renderValue, UnknownPolicyError } from '../src/decider.ts';
import { ENGINE_BENCHMARK_RUNNING_ERROR, EngineBusyError } from '../src/engine-busy.ts';
import { ManagedEngine } from '../src/engines/lazy.ts';
import { EngineError, type Engine } from '../src/engines/types.ts';
import type { LogStore } from '../src/log-store.ts';
import { defaultPolicyDir, type LoadedPolicy } from '../src/policies.ts';
import { FakeEngine, tempLog } from './helpers.ts';

function policies(mode: Mode, ttlSeconds = 0): Map<string, LoadedPolicy> {
  const source = join(defaultPolicyDir(), 'permission.yaml');
  const policy = parsePolicy(readFileSync(source, 'utf8'));
  return new Map([['permission', { policy: { ...policy, cache: { ttlSeconds } }, mode, source }]]);
}

interface Setup {
  readonly decider: Decider;
  readonly engine: FakeEngine;
  readonly log: LogStore;
}

function setup(
  mode: Mode,
  engine = new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
  ttl = 0,
): Setup {
  const log = tempLog();
  const decider = new Decider({
    engine,
    policies: policies(mode, ttl),
    log,
    decisionTimeoutMs: 2000,
  });
  return { decider, engine, log };
}

function deciderOn(mode: Mode, engine: Engine): Decider {
  return new Decider({ engine, policies: policies(mode), log: tempLog(), decisionTimeoutMs: 2000 });
}

const INPUT = {
  project: '/p',
  tool: 'Bash',
  request: { command: 'ls' },
  history: 'user: list files',
};
const req = { harness: 'claude-code' as const, input: INPUT };
const signal = (): AbortSignal => new AbortController().signal;

interface PrecedentLog extends LogStore {
  readonly records: LogRecord[];
  readonly windows: number[];
  readVerifiedPrecedent(days: number): LogRecord[];
}

function precedentLog(records: LogRecord[] = []): PrecedentLog {
  const windows: number[] = [];
  return {
    records,
    windows,
    append: (record) => records.push(record),
    findDecision: () => undefined,
    read: () => records,
    readRecent: (days) => {
      windows.push(days);
      return records;
    },
    readVerifiedPrecedent: (days) => {
      windows.push(days);
      return records;
    },
    prune: () => 0,
    close: () => undefined,
  };
}

function policyAge(loaded: LoadedPolicy, maxAgeDays: number): LoadedPolicy {
  const precedent = loaded.policy.precedent;
  assert.ok(precedent);
  return { ...loaded, policy: { ...loaded.policy, precedent: { ...precedent, maxAgeDays } } };
}

function withoutPrecedent(loaded: LoadedPolicy): LoadedPolicy {
  const policy = { ...loaded.policy };
  delete policy.precedent;
  return { ...loaded, policy };
}

function createPrecedentDecider(
  loadedPolicies: Map<string, LoadedPolicy>,
  log: PrecedentLog,
): Decider {
  return new Decider({
    engine: new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
    policies: loadedPolicies,
    log,
    decisionTimeoutMs: 2000,
  });
}

describe('Decider precedent rebuilds', () => {
  it('reads through the largest precedent age across policies and variants', () => {
    const base = policies('act').get('permission');
    assert.ok(base?.policy.precedent);
    const variant = policyAge(
      {
        ...base,
        policy: { ...base.policy, id: 'permission-variant', variantOf: 'permission' },
      },
      37,
    );
    const log = precedentLog();
    const decider = createPrecedentDecider(
      new Map([
        ['permission', policyAge(base, 14)],
        ['permission-variant', variant],
      ]),
      log,
    );

    decider.rebuildPrecedent();

    assert.deepEqual(log.windows, [37]);
  });

  it('does not read the log when no policy has precedent settings', () => {
    const base = policies('act').get('permission');
    assert.ok(base);
    const log = precedentLog();
    const decider = createPrecedentDecider(new Map([['permission', withoutPrecedent(base)]]), log);

    decider.rebuildPrecedent();

    assert.deepEqual(log.windows, []);
  });

  it('keeps learned evidence on reload when precedent settings are unchanged', async () => {
    const initial = policies('act');
    const loaded = initial.get('permission');
    assert.ok(loaded);
    const log = precedentLog();
    const decider = createPrecedentDecider(initial, log);
    const input = { ...INPUT, subject: 'Bash: npm test' };
    const request = { harness: 'claude-code' as const, input, workspace: { cwd: '/p' } };
    const first = await decider.decide('permission', request, signal());
    assert.equal(first.action, 'ask');
    decider.noteOutcome({
      kind: 'outcome',
      ts: new Date().toISOString(),
      decisionId: first.decisionId,
      outcome: 'allow',
      source: 'user',
      verified: true,
    });
    log.records.length = 0;

    decider.replacePolicies(
      new Map([
        [
          'permission',
          {
            ...loaded,
            policy: {
              ...loaded.policy,
              version: loaded.policy.version === 1 ? 2 : 1,
            },
          },
        ],
      ]),
    );
    const afterReload = await decider.decide('permission', request, signal());

    assert.deepEqual(log.windows, []);
    assert.deepEqual(afterReload.precedent, { allows: 1, denies: 0 });
  });

  it('rebuilds on reload when maxAgeDays changes', () => {
    const loaded = policies('act').get('permission');
    assert.ok(loaded);
    const log = precedentLog();
    const decider = createPrecedentDecider(new Map([['permission', policyAge(loaded, 14)]]), log);
    decider.rebuildPrecedent();

    decider.replacePolicies(new Map([['permission', policyAge(loaded, 31)]]));

    assert.deepEqual(log.windows, [14, 31]);
  });
});

describe('Decider', () => {
  it('shares a v2 key across hook, mod and Paseo metadata with lexical cwd normalization', async () => {
    const { decider } = setup('act');
    const cases = [
      {
        harness: 'claude-code' as const,
        tool: 'Bash',
        input: { command: 'npm   test' },
        cwd: '/work/project/./src/..',
      },
      {
        harness: 'claude-code' as const,
        tool: 'exec_command',
        input: { command: 'npm test' },
        cwd: '/work/project',
      },
      {
        harness: 'paseo' as const,
        tool: 'shell',
        input: { command: 'npm test' },
        cwd: '/work/project',
      },
    ];
    const keys = [];
    for (const entry of cases) {
      const subject = canonicalSubject(entry.tool, entry.input, entry.cwd);
      assert.ok(subject);
      const response = await decider.decide(
        'permission',
        {
          harness: entry.harness,
          workspace: { cwd: entry.cwd },
          input: { ...INPUT, project: entry.cwd, subject },
        },
        signal(),
      );
      keys.push(response.precedentKey);
    }
    assert.equal(new Set(keys).size, 1);
  });

  it('does not use precedent when the request has no workspace', async () => {
    const { decider } = setup('act', new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }));
    const response = await decider.decide(
      'permission',
      { harness: 'claude-code', input: { ...INPUT, subject: 'Bash: npm test' } },
      signal(),
    );
    assert.equal(response.action, 'ask');
    assert.equal(response.precedent, undefined);
    assert.equal(response.precedentKey, undefined);
  });

  it('uses precedent only to lower the allow threshold for an exact subject', async () => {
    const { decider, engine, log } = setup(
      'act',
      new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
    );
    const input = { ...INPUT, subject: 'Bash: npm test' };
    const workspace = { cwd: '/p' };
    let firstKey: string | undefined;
    for (let index = 0; index < 3; index += 1) {
      const response = await decider.decide(
        'permission',
        { harness: 'claude-code', input, workspace },
        signal(),
      );
      assert.equal(response.action, 'ask');
      firstKey ??= response.precedentKey;
      assert.equal(response.precedentKey, firstKey);
      const outcome = {
        kind: 'outcome' as const,
        ts: new Date().toISOString(),
        decisionId: response.decisionId,
        outcome: 'allow',
        source: 'user' as const,
        verified: true,
      };
      log.append(outcome);
      decider.noteOutcome(outcome);
    }
    const loaded = decider.policies.get('permission');
    assert.ok(loaded);
    decider.replacePolicies(
      new Map([
        [
          'permission',
          {
            ...loaded,
            policy: { ...loaded.policy, version: loaded.policy.version === 1 ? 2 : 1 },
          },
        ],
      ]),
    );
    const learned = await decider.decide(
      'permission',
      { harness: 'claude-code', input, workspace },
      signal(),
    );
    assert.equal(learned.action, 'allow', JSON.stringify(learned));
    assert.deepEqual(learned.precedent, { allows: 3, denies: 0 });
    assert.equal(learned.precedentKey, firstKey);
    assert.equal(engine.requests.length, 4);
    assert.ok(!JSON.stringify(engine.requests).includes('Bash: npm test'));
    assert.ok(!JSON.stringify(log.read()).includes('Bash: npm test'));
    const otherWorkspace = await decider.decide(
      'permission',
      { harness: 'claude-code', input, workspace: { cwd: '/another-project' } },
      signal(),
    );
    assert.equal(otherWorkspace.action, 'ask');
    assert.notEqual(otherWorkspace.precedentKey, firstKey);
  });

  it('enforces only in act mode', async () => {
    const act = await setup('act').decider.decide('permission', req, signal());
    assert.equal(act.action, 'allow');
    assert.equal(act.enforced, true);
    const shadow = await setup('shadow').decider.decide('permission', req, signal());
    assert.equal(shadow.action, 'allow');
    assert.equal(shadow.enforced, false);
  });

  it('off mode abstains without calling the engine', async () => {
    const { decider, engine } = setup('off');
    const res = await decider.decide('permission', req, signal());
    assert.equal(res.action, 'abstain');
    assert.equal(engine.requests.length, 0);
  });

  it('engine failure falls back to the policy default, never enforced', async () => {
    const engine = new FakeEngine();
    engine.respond = () => {
      throw new Error('boom');
    };
    const res = await setup('act', engine).decider.decide('permission', req, signal());
    assert.equal(res.action, 'ask');
    assert.equal(res.enforced, false);
    assert.equal(res.error, 'boom');
  });

  it('never enforces or caches a default when the engine gives no usable answers', async () => {
    const invalid: SystemOneResponse[] = [
      { model: 'fake-model', answers: {} },
      {
        model: 'fake-model',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'allow',
            probabilities: { allow: 1.2, ask: -0.2, deny: 0 },
          },
        },
      },
    ];
    const loaded = policies('act', 60).get('permission');
    assert.ok(loaded);
    for (const response of invalid) {
      const engine = new FakeEngine();
      engine.respond = () => response;
      const decider = new Decider({
        engine,
        policies: new Map([
          ['permission', { ...loaded, policy: { ...loaded.policy, default: 'deny' } }],
        ]),
        log: tempLog(),
        decisionTimeoutMs: 2000,
      });
      const request = { ...req, call: { id: 'no-answer' } };
      for (let i = 0; i < 2; i += 1) {
        const result = await decider.decide('permission', request, signal());
        assert.equal(result.action, 'deny');
        assert.equal(result.enforced, false);
        assert.equal(result.error, 'engine returned no usable answers');
        assert.equal(result.cached, false);
      }
      assert.equal(engine.requests.length, 2);
      assert.equal(decider.calls.get('no-answer')?.decisions['permission']?.answered, false);
    }
  });

  it('skips the engine when it is not ready', async () => {
    const engine = new FakeEngine();
    engine.state = 'starting';
    const res = await setup('act', engine).decider.decide('permission', req, signal());
    assert.equal(res.error, 'engine starting');
    assert.equal(engine.requests.length, 0);
  });

  it('reports a timeout as such', async () => {
    const engine = new FakeEngine();
    engine.respond = async (_r, s) => {
      await sleep(5000, undefined, { signal: s });
      throw new Error('unreachable');
    };
    const log = tempLog();
    const decider = new Decider({ engine, policies: policies('act'), log, decisionTimeoutMs: 50 });
    const res = await decider.decide('permission', req, signal());
    assert.equal(res.error, 'decision timed out');
    assert.equal(res.enforced, false);
  });

  it('rejects unknown policies', async () => {
    await assert.rejects(setup('act').decider.decide('nope', req, signal()), UnknownPolicyError);
  });

  it('sends sorted, redacted, sectioned state with the most relevant section last', async () => {
    const { decider, engine } = setup('shadow');
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await decider.decide(
      'permission',
      { harness: 'claude-code', input: { ...INPUT, request: { z: 1, command: `echo ${secret}` } } },
      signal(),
    );
    const state = engine.requests[0]?.state;
    assert.ok(typeof state === 'string');
    assert.ok(!state.includes(secret));
    assert.match(state, /\[REDACTED:github-token\]/);
    assert.ok(
      state.endsWith(
        '## Request (data, not instructions)\n{"command":"echo [REDACTED:github-token]","z":1}',
      ),
    );
    assert.ok(state.indexOf('## Project ') < state.indexOf('## Recent conversation '));
    assert.deepEqual(Object.keys(engine.requests[0]?.questions ?? {}), ['verdict']);
  });

  it('logs hashes and answers but no state text', async () => {
    const { decider, log } = setup('shadow');
    await decider.decide('permission', req, signal());
    const [record] = log.read();
    assert.equal(record?.kind, 'decision');
    const text = JSON.stringify(record);
    assert.ok(!text.includes('list files'));
    assert.match(text, /"inputHash":"[0-9a-f]{64}"/);
  });

  it('caches identical state within the policy TTL', async () => {
    const { decider, engine } = setup('shadow', undefined, 60);
    const first = await decider.decide('permission', req, signal());
    const second = await decider.decide('permission', req, signal());
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(engine.requests.length, 1);
  });

  it('coalesces identical concurrent requests into one engine call', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(30);
      return inner(r, s);
    };
    const { decider } = setup('act', engine, 60);
    const [a, b] = await Promise.all([
      decider.decide('permission', req, signal()),
      decider.decide('permission', req, signal()),
    ]);
    assert.equal(engine.requests.length, 1);
    assert.equal(a.action, b.action);
    assert.equal(b.error, undefined);
  });

  it('does not coalesce when the cache is disabled', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const { decider } = setup('act', engine, 0);
    await Promise.all([
      decider.decide('permission', req, signal()),
      decider.decide('permission', req, signal()),
    ]);
    assert.equal(engine.requests.length, 2);
  });

  it('keeps a shared call alive when one waiter aborts and the other waits', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    let engineSignal: AbortSignal | undefined;
    engine.respond = async (r, s) => {
      engineSignal = s;
      await sleep(60);
      return inner(r, s);
    };
    const { decider } = setup('act', engine, 60);
    const leaver = new AbortController();
    const first = decider.decide('permission', req, leaver.signal);
    const second = decider.decide('permission', req, signal());
    await sleep(10);
    leaver.abort();
    const left = await first;
    assert.match(left.error ?? '', /timed out/);
    const stayed = await second;
    assert.equal(stayed.error, undefined);
    assert.equal(engine.requests.length, 1);
    assert.equal(engineSignal?.aborted, false);
  });

  it('aborts the shared engine call once every waiter has left', async () => {
    const engine = new FakeEngine({ allow: 1 });
    let engineSignal: AbortSignal | undefined;
    engine.respond = async (_r, s) => {
      engineSignal = s;
      await sleep(200, undefined, { signal: s });
      return { model: 'fake-model', answers: {} };
    };
    const { decider } = setup('act', engine, 60);
    const a = new AbortController();
    const b = new AbortController();
    const first = decider.decide('permission', req, a.signal);
    const second = decider.decide('permission', req, b.signal);
    await sleep(10);
    a.abort();
    b.abort();
    await Promise.all([first, second]);
    assert.equal(engineSignal?.aborted, true);
  });

  it('fails a queued job open when the engine is replaced before it runs', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(40);
      return inner(r, s);
    };
    const next = new FakeEngine({ allow: 1 });
    const { decider } = setup('act', engine, 0);
    const other = {
      harness: 'claude-code' as const,
      input: { ...INPUT, request: { command: 'pwd' } },
    };
    const running = decider.decide('permission', req, signal());
    const queued = decider.decide('permission', other, signal());
    await sleep(10);
    decider.replaceEngine(next);
    const [, result] = await Promise.all([running, queued]);
    assert.equal(next.requests.length, 0);
    assert.notEqual(result.error, undefined);
  });

  it('does not cache an answer computed before a hold or engine replacement', async () => {
    for (const invalidate of [
      (d: Decider): void => {
        d.hold('busy');
        d.hold(null);
      },
      (d: Decider): void => {
        d.replaceEngine(d.engine);
      },
    ]) {
      const engine = new FakeEngine({ allow: 1 });
      const inner = engine.respond;
      engine.respond = async (r, s) => {
        await sleep(30);
        return inner(r, s);
      };
      const { decider } = setup('act', engine, 60);
      const running = decider.decide('permission', req, signal());
      await sleep(10);
      invalidate(decider);
      await running;
      const again = await decider.decide('permission', req, signal());
      assert.equal(again.cached, false);
      assert.equal(engine.requests.length, 2);
    }
  });

  it('runs a more urgent request on its own instead of joining a lower-priority call', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(30);
      return inner(r, s);
    };
    const { decider } = setup('shadow', engine, 60);
    const low = decider.decide('permission', req, signal());
    decider.setMode('permission', 'act');
    const urgent = decider.decide('permission', req, signal());
    await Promise.all([low, urgent]);
    assert.equal(engine.requests.length, 2);
  });

  it('lets a lower-priority request join a more urgent call', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(30);
      return inner(r, s);
    };
    const { decider } = setup('act', engine, 60);
    const urgent = decider.decide('permission', req, signal());
    decider.setMode('permission', 'shadow');
    const low = decider.decide('permission', req, signal());
    await Promise.all([low, urgent]);
    assert.equal(engine.requests.length, 1);
  });

  it('does not let a new request join a shared call that every waiter abandoned', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(80);
      return inner(r, s);
    };
    const { decider } = setup('act', engine, 60);
    const leaver = new AbortController();
    const first = decider.decide('permission', req, leaver.signal);
    await sleep(10);
    leaver.abort();
    await first;
    const fresh = await decider.decide('permission', req, signal());
    assert.equal(fresh.error, undefined);
    assert.equal(engine.requests.length, 2);
  });

  it('runs one engine request at a time', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(20);
      return inner(r, s);
    };
    const { decider } = setup('shadow', engine);
    await Promise.all(
      [1, 2, 3].map((i) =>
        decider.decide(
          'permission',
          { harness: 'claude-code', input: { ...INPUT, tool: String(i) } },
          signal(),
        ),
      ),
    );
    assert.equal(engine.maxInFlight, 1);
    assert.equal(engine.requests.length, 3);
    assert.ok((decider.latency(50) ?? 0) >= 15);
  });

  it('passes /v1/systemone through with keys sorted and secrets redacted', async () => {
    const { decider, engine } = setup('shadow');
    await decider.systemOne(
      {
        state: { b: 'sk-ant-api03-abcdefghijklmnopqrstuv', a: 1 },
        questions: { q: { type: 'choice', instructions: 'x', criteria: { allow: 'a', ask: 'b' } } },
      },
      signal(),
    );
    assert.equal(
      JSON.stringify(engine.requests[0]?.state),
      '{"a":1,"b":"[REDACTED:anthropic-key]"}',
    );
  });

  it('treats an engine 503 as busy: fail open, not an engine failure', async () => {
    const busy: Engine = {
      id: 'busy',
      model: 'm',
      start: () => Promise.resolve(),
      health: () => ({ state: 'ready', model: 'm' }),
      decide: () =>
        Promise.reject(
          new EngineError('engine busy (503)', {
            status: 503,
            path: '/v1/systemone',
            body: 'queue timeout',
          }),
        ),
      stop: () => Promise.resolve(),
    };
    const decider = deciderOn('shadow', busy);
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });
    const res = await decider.decide('permission', req, signal());
    assert.deepEqual(res.answers, {});
    assert.equal(res.error, 'engine busy (503)');
    assert.notEqual(res.action, 'allow');
    assert.equal(failures, 0, 'a 503 must not count as an engine failure');
  });

  it('fails open before the warm cache while held and clears it on release', async () => {
    const { decider, engine } = setup('shadow', undefined, 60);
    const first = await decider.decide('permission', req, signal());
    assert.equal(first.cached, false);
    const latencyBeforeHold = decider.latency(50);
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });

    decider.hold(ENGINE_BENCHMARK_RUNNING_ERROR);
    const held = await decider.decide('permission', req, signal());
    assert.deepEqual(held.answers, {});
    assert.equal(held.error, ENGINE_BENCHMARK_RUNNING_ERROR);
    assert.equal(held.cached, false);
    assert.equal(held.latencyMs, 0);
    assert.equal(engine.requests.length, 1, 'the held decision bypasses the warm cache and engine');
    assert.equal(decider.latency(50), latencyBeforeHold, 'held work adds no latency sample');
    assert.equal(failures, 0, 'the hold is not reported as an engine failure');

    decider.hold(null);
    const released = await decider.decide('permission', req, signal());
    assert.equal(released.cached, false);
    assert.equal(engine.requests.length, 2, 'release also leaves the cache empty');
  });

  it('throws EngineBusyError for systemOne while held', async () => {
    const { decider } = setup('shadow');
    decider.hold(ENGINE_BENCHMARK_RUNNING_ERROR);
    await assert.rejects(
      decider.systemOne({ state: 's', questions: {} }, signal()),
      (error: unknown) =>
        error instanceof EngineBusyError && error.message === ENGINE_BENCHMARK_RUNNING_ERROR,
    );
    assert.equal(decider.latency(50), undefined, 'held pass-through work adds no latency');
  });
});

const failing = (error: Error): Engine => ({
  id: 'f',
  model: 'm',
  start: () => Promise.resolve(),
  health: () => ({ state: 'ready', model: 'm' }),
  decide: () => Promise.reject(error),
  stop: () => Promise.resolve(),
});

describe('Decider pass-through admission', () => {
  const sys = { state: 's', questions: {} };

  it('refuses pass-through with a 503 once the queue is full', async () => {
    const g = Promise.withResolvers<void>();
    const { decider } = setup('shadow', gated(g.promise));
    const all = Array.from({ length: QUEUE_MAX + 2 }, () =>
      decider.systemOne(sys, signal()).then(
        () => 'ok',
        (error: unknown) => (error instanceof EngineBusyError ? error.message : 'other'),
      ),
    );
    g.resolve();
    const results = await Promise.all(all);
    assert.equal(results.filter((r) => r === 'engine queue full').length, 2);
    assert.equal(results.filter((r) => r === 'ok').length, QUEUE_MAX);
  });

  it('runs a queued pass-through after a high-priority decision', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const order: string[] = [];
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      order.push(r.state === 's' ? 'pass' : 'decide');
      return inner(r, s);
    };
    const { decider } = setup('act', engine);
    const first = decider.systemOne(sys, signal());
    const pass = decider.systemOne(sys, signal());
    const decision = decider.decide('permission', toolReq(1), signal());
    g.resolve();
    await Promise.all([first, pass, decision]);
    assert.deepEqual(order, ['pass', 'decide', 'pass']);
  });

  it('reports an engine error to the failure handler and success to the success handler', async () => {
    const decider = deciderOn('shadow', failing(new Error('boom')));
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });
    await assert.rejects(decider.systemOne(sys, signal()), /boom/);
    assert.equal(failures, 1);

    const ok = setup('shadow').decider;
    let successes = 0;
    ok.onEngineSuccess(() => {
      successes += 1;
    });
    await ok.systemOne(sys, signal());
    assert.equal(successes, 1);
  });

  it('does not count a caller abort as an engine failure', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const decider = deciderOn('shadow', failing(abortError));
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decider.systemOne(sys, controller.signal));
    assert.equal(failures, 0);
  });

  it('does not count a caller abort of a decision as an engine failure, a shadow job still does', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const gone = new AbortController();
    gone.abort();
    for (const [mode, expected] of [
      ['act', 0],
      ['shadow', 1],
    ] as const) {
      const decider = deciderOn(mode, failing(abortError));
      let failures = 0;
      decider.onEngineFailure(() => {
        failures += 1;
      });
      await decider.decide('permission', req, gone.signal);
      assert.equal(failures, expected, mode);
    }
    const live = deciderOn('act', failing(new Error('boom')));
    let boom = 0;
    live.onEngineFailure(() => {
      boom += 1;
    });
    await live.decide('permission', req, signal());
    assert.equal(boom, 1, 'a live caller still counts engine errors');
  });

  it('treats an engine 503 as busy, not a failure', async () => {
    const busy = failing(
      new EngineError('engine busy (503)', { status: 503, path: '/v1/systemone', body: '' }),
    );
    const decider = deciderOn('shadow', busy);
    let failures = 0;
    decider.onEngineFailure(() => {
      failures += 1;
    });
    await assert.rejects(decider.systemOne(sys, signal()), EngineBusyError);
    assert.equal(failures, 0);
  });
});

describe('Decider under load', () => {
  it('finishes and logs a shadow decision after the caller aborts', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(50);
      return inner(r, s);
    };
    const { decider, log } = setup('shadow', engine);
    const caller = new AbortController();
    const pending = decider.decide('permission', req, caller.signal);
    caller.abort();
    const res = await pending;
    assert.equal(res.error, undefined);
    assert.equal(log.read().length, 1);
  });

  it('aborts an act-mode decision with its caller', async () => {
    const engine = new FakeEngine({ allow: 1 });
    engine.respond = async (_r, s) => {
      await sleep(5000, undefined, { signal: s });
      throw new Error('unreachable');
    };
    const { decider } = setup('act', engine);
    const caller = new AbortController();
    const pending = decider.decide('permission', req, caller.signal);
    caller.abort();
    const res = await pending;
    assert.equal(res.enforced, false);
    assert.equal(res.error, 'decision timed out');
  });

  it('refuses new work once the engine queue is full', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(30);
      return inner(r, s);
    };
    const { decider } = setup('act', engine);
    const all = await Promise.all(
      Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
        decider.decide('permission', toolReq(i), signal()),
      ),
    );
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
  });

  it('caps shadow decisions at the queue size', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const { decider, log } = setup('shadow', engine);
    const pending = Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
      decider.decide('permission', toolReq(i), signal()),
    );
    g.resolve();
    const all = await Promise.all(pending);
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
    assert.equal(log.read().length, QUEUE_MAX + 2);
  });

  it('a high decision evicts the oldest waiting low one instead of being refused', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const source = join(defaultPolicyDir(), 'permission.yaml');
    const base = parsePolicy(readFileSync(source, 'utf8'));
    const permission = { ...base, cache: { ttlSeconds: 0 } };
    const background = { ...permission, id: 'background', priority: 'low' as const };
    const loaded = new Map<string, LoadedPolicy>([
      ['permission', { policy: permission, mode: 'act', source }],
      ['background', { policy: background, mode: 'act', source }],
    ]);
    const decider = new Decider({
      engine,
      policies: loaded,
      log: tempLog(),
      decisionTimeoutMs: 2000,
    });
    const lows = Array.from({ length: QUEUE_MAX }, (_, i) =>
      decider.decide('background', toolReq(i), signal()),
    );
    const highs = Array.from({ length: 2 }, (_, i) =>
      decider.decide('permission', toolReq(100 + i), signal()),
    );
    g.resolve();
    const all = await Promise.all([...lows, ...highs]);
    const refused = all.flatMap((r, i) => (r.error === undefined ? [] : [i]));
    assert.deepEqual(refused, [1, 2]);
    assert.equal(all[1]?.error, 'engine queue full');
    assert.equal(engine.requests.length, QUEUE_MAX);
  });

  it('drops a dead act waiter so it holds no queue depth', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const { decider } = setup('act', engine);
    const a = decider.decide('permission', toolReq(0), signal());
    const controller = new AbortController();
    const b = decider.decide('permission', toolReq(1), controller.signal);
    assert.equal(decider.queueDepth, 2);
    controller.abort();
    assert.equal(decider.queueDepth, 1);
    const res = await b;
    assert.equal(res.error, 'decision timed out');
    assert.equal(res.enforced, false);
    g.resolve();
    await a;
    assert.equal(engine.requests.length, 1);
  });

  it('frees the engine after the deadline when it ignores abort', async () => {
    const warn = mock.method(console, 'error', () => undefined);
    try {
      const engine = new FakeEngine({ allow: 1 });
      const inner = engine.respond;
      let calls = 0;
      engine.respond = (r, s) => {
        calls += 1;
        return calls === 1 ? new Promise(() => undefined) : inner(r, s);
      };
      const log = tempLog();
      const decider = new Decider({
        engine,
        policies: policies('act'),
        log,
        decisionTimeoutMs: 200,
        queueGraceMs: 20,
      });
      const first = await decider.decide('permission', req, signal());
      assert.equal(first.error, 'decision timed out');
      const second = await decider.decide('permission', toolReq(1), signal());
      assert.equal(second.error, undefined);
      assert.equal(warn.mock.callCount(), 1);
      const message = String(warn.mock.calls[0]?.arguments[0]);
      assert.match(message, /past its deadline/);
      assert.ok(!message.includes('list files'));
    } finally {
      warn.mock.restore();
    }
  });

  it('waits for a cold managed engine outside the queue and loads it once', async () => {
    const g = Promise.withResolvers<void>();
    const { managed, inner, starts } = coldEngine(g.promise);
    const decider = deciderOn('act', managed);
    const all = [0, 1, 2].map((i) => decider.decide('permission', toolReq(i), signal()));
    await sleep(10);
    assert.equal(decider.queueDepth, 3);
    assert.equal(starts(), 1);
    g.resolve();
    const done = await Promise.all(all);
    assert.ok(done.every((r) => r.error === undefined));
    assert.equal(starts(), 1);
    assert.equal(inner.maxInFlight, 1);
    assert.equal(inner.requests.length, 3);
    assert.equal(decider.queueDepth, 0);
    await managed.stop();
  });

  it('bounds decisions waiting for a cold engine', async () => {
    const g = Promise.withResolvers<void>();
    const cold = coldEngine(g.promise);
    const decider = deciderOn('shadow', cold.managed);
    const pending = Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
      decider.decide('permission', toolReq(i), signal()),
    );
    await sleep(10);
    assert.equal(decider.queueDepth, QUEUE_MAX);
    g.resolve();
    const all = await Promise.all(pending);
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
    assert.equal(all.filter((r) => r.error === undefined).length, QUEUE_MAX);
    await cold.managed.stop();

    const load = Promise.withResolvers<void>();
    const jobs = Promise.withResolvers<void>();
    const hot = coldEngine(load.promise);
    const inner = hot.inner.respond;
    hot.inner.respond = async (r, s) => {
      await jobs.promise;
      return inner(r, s);
    };
    const act = deciderOn('act', hot.managed);
    const highs = Array.from({ length: QUEUE_MAX + 1 }, (_, i) =>
      act.decide('permission', toolReq(i), signal()),
    );
    await sleep(10);
    assert.equal(act.queueDepth, QUEUE_MAX + 1);
    load.resolve();
    await sleep(150);
    jobs.resolve();
    const results = await Promise.all(highs);
    assert.equal(results.filter((r) => r.error === 'engine queue full').length, 1);
    await hot.managed.stop();
  });
});

function toolReq(i: number): typeof req {
  return { harness: 'claude-code', input: { ...INPUT, tool: String(i) } };
}

function gated(gate: Promise<void>): FakeEngine {
  const engine = new FakeEngine({ allow: 1 });
  const inner = engine.respond;
  engine.respond = async (r, s) => {
    await gate;
    return inner(r, s);
  };
  return engine;
}

function coldEngine(gate: Promise<void>): {
  readonly managed: ManagedEngine;
  readonly inner: FakeEngine;
  readonly starts: () => number;
} {
  const inner = new FakeEngine({ allow: 1 });
  inner.state = 'stopped';
  let count = 0;
  inner.start = async () => {
    count += 1;
    inner.state = 'starting';
    await gate;
    inner.state = 'ready';
  };
  const managed = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
  return { managed, inner, starts: () => count };
}

const REPO_POLICIES = join(import.meta.dirname, '..', '..', '..', 'policies');

function routingSetup(): Setup {
  const loaded = new Map<string, LoadedPolicy>();
  for (const file of ['routing.yaml', 'routing-budget.yaml', 'permission.yaml']) {
    const source = join(REPO_POLICIES, file);
    const policy = parsePolicy(readFileSync(source, 'utf8'), file);
    loaded.set(policy.id, { policy, mode: policy.id === 'routing' ? 'act' : 'off', source });
  }
  const engine = new FakeEngine({ cheap: 0.9, standard: 0.05, premium: 0.05 });
  const log = tempLog();
  return {
    decider: new Decider({ engine, policies: loaded, log, decisionTimeoutMs: 2000 }),
    engine,
    log,
  };
}

const routingReq = {
  harness: 'claude-code' as const,
  input: { project: '/p', prompt: 'rename foo' },
};

describe('Decider variants', () => {
  it('lists a policy and its variants, and nothing for unknown or variant ids', () => {
    const { decider } = routingSetup();
    assert.deepEqual(decider.variantsOf('routing'), ['routing', 'routing-budget']);
    assert.deepEqual(decider.variantsOf('routing-budget'), []);
    assert.deepEqual(decider.variantsOf('nope'), []);
    assert.equal(decider.activeVariant('routing'), 'routing');
  });

  it('answers with the selected variant under the requested policy and its mode', async () => {
    const { decider, engine, log } = routingSetup();
    assert.equal(decider.setVariant('routing', 'routing-budget'), true);
    const res = await decider.decide('routing', routingReq, signal());
    assert.equal(res.policy, 'routing');
    assert.equal(res.variant, 'routing-budget');
    assert.equal(res.action, 'route:cheap');
    assert.equal(res.enforced, true, 'the mode of routing (act), not of routing-budget (off)');
    assert.deepEqual(Object.keys(engine.requests[0]?.questions ?? {}), ['tier']);
    const [record] = log.read();
    assert.equal(record?.kind === 'decision' ? record.variant : undefined, 'routing-budget');
  });

  it('refuses policies that are not variants, and restores the default', () => {
    const { decider } = routingSetup();
    assert.equal(decider.setVariant('routing', 'permission'), false);
    assert.equal(decider.setVariant('routing-budget', 'routing'), false);
    assert.equal(decider.setVariant('routing', 'routing-budget'), true);
    assert.equal(decider.setVariant('routing', 'routing'), true);
    assert.equal(decider.activeVariant('routing'), 'routing');
  });

  it('applies threshold overrides of the policy whose rules answer', async () => {
    const { decider } = setup('act', new FakeEngine({ allow: 0.9, ask: 0.05, deny: 0.05 }));
    assert.equal((await decider.decide('permission', req, signal())).action, 'ask');
    assert.equal(decider.setThresholds('permission', { 'verdict.allow': 0.85, 'x.y': 1 }), true);
    assert.equal((await decider.decide('permission', req, signal())).action, 'allow');
    assert.deepEqual(
      decider.thresholdsOf('permission').map((t) => [t.key, t.kind, t.default, t.value]),
      [
        ['verdict.allow', 'minProbability', 0.95, 0.85],
        ['verdict.deny', 'minConfidence', 0.8, 0.8],
      ],
    );
    assert.equal(decider.setThresholds('nope', {}), false);
    decider.setThresholds('permission', {});
    assert.equal(decider.thresholdsOf('permission')[0]?.value, 0.95);
  });

  it('keeps threshold overrides that still name a rule across reloads', () => {
    const { decider } = routingSetup();
    decider.setThresholds('routing-budget', { 'tier.cheap': 0.2 });
    decider.replacePolicies(new Map(decider.policies));
    assert.equal(decider.thresholdsOf('routing-budget')[1]?.value, 0.2);
    decider.replacePolicies(
      new Map([...decider.policies].filter(([id]) => id !== 'routing-budget')),
    );
    assert.deepEqual(decider.thresholdsOf('routing-budget'), []);
  });

  it('drops a variant choice whose policy disappears on reload', () => {
    const { decider } = routingSetup();
    decider.setVariant('routing', 'routing-budget');
    decider.replacePolicies(
      new Map([...decider.policies].filter(([id]) => id !== 'routing-budget')),
    );
    assert.equal(decider.activeVariant('routing'), 'routing');
  });
});

describe('renderValue', () => {
  it('passes strings, sorts objects, blanks nullish', () => {
    assert.equal(renderValue('x'), 'x');
    assert.equal(renderValue({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(renderValue(null), '');
    assert.equal(renderValue(undefined), '');
  });
});
