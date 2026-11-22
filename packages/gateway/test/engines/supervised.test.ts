import assert from 'node:assert/strict';
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { trackedChildCount } from '../../src/engines/child-reaper.ts';
import { ManagedEngine } from '../../src/engines/lazy.ts';
import { SupervisedEngine, type ServerSpec } from '../../src/engines/supervised.ts';
import { tempPaths } from '../helpers.ts';

const POLL_MS = 500;
const GRACE_MS = 10_000;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Ignore SIGTERM, like a wedged engine; SIGKILL always lands. */
  hangOnTerm = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.hangOnTerm) {
      return true;
    }
    this.die(null, signal);
    return true;
  }

  die(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code ?? (signal === null ? 0 : null);
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface Waiter {
  readonly ms: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface Harness {
  readonly engine: SupervisedEngine;
  readonly children: FakeChild[];
  /** Delays of every non-poll sleep, in order. */
  readonly delays: number[];
  readonly waiting: Waiter[];
  readonly clock: { now: number };
  /** `/health` answer; `probes` counts requests, `hold` delays the answer. */
  readonly health: { ok: boolean; probes: number; hold: Promise<void> | undefined };
  /** What a `/v1/systemone` POST does. */
  readonly post: { mode: 'ok' | 'timeout' | 'busy' };
  readonly fakeFreePort: { fail: boolean };
  readonly fakeSpawn: { fail: boolean };
  /** New children ignore SIGTERM while this is on. */
  readonly hang: { on: boolean };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await flush();
  }
}

function decideFetch(
  mode: 'ok' | 'timeout' | 'busy',
  signal?: AbortSignal | null,
): Promise<Response> {
  if (mode === 'busy') {
    return Promise.resolve(new Response('busy', { status: 503 }));
  }
  if (mode === 'ok') {
    return Promise.resolve(new Response('{"answers":{}}', { status: 200 }));
  }
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as Error));
  });
}

const REQUEST = { questions: [] } as unknown as Parameters<SupervisedEngine['decide']>[0];

/** One decision. `how` picks how it ends: the decision deadline, a caller abort, or the engine. */
async function decide(h: Harness, how: 'timeout' | 'abort' | 'engine'): Promise<void> {
  const controller = new AbortController();
  h.post.mode = how === 'engine' ? h.post.mode : 'timeout';
  const pending = h.engine.decide(REQUEST, controller.signal).catch(() => undefined);
  await flush();
  if (how === 'timeout') {
    controller.abort(new DOMException('deadline', 'TimeoutError'));
  } else if (how === 'abort') {
    controller.abort();
  }
  await pending;
  await settle();
}

function makeSpec(timeoutSeconds: number): ServerSpec {
  return {
    id: 'sup-test',
    model: 'm',
    startTimeoutSeconds: timeoutSeconds,
    healthPath: '/health',
    binary: () => ({ path: process.execPath }),
    args: () => [],
  };
}

function harness(timeoutSeconds = 2): Harness {
  const children: FakeChild[] = [];
  const delays: number[] = [];
  const waiting: Waiter[] = [];
  const clock = { now: 1_000_000 };
  const health: Harness['health'] = { ok: false, probes: 0, hold: undefined };
  const post: Harness['post'] = { mode: 'ok' };
  const fakeFreePort = { fail: false };
  const fakeSpawn = { fail: false };
  const hang = { on: false };
  const deps = {
    now: () => clock.now,
    freePort: (): Promise<number> =>
      fakeFreePort.fail ? Promise.reject(new Error('no port')) : Promise.resolve(4000),
    spawn: ((): ChildProcess => {
      if (fakeSpawn.fail) {
        throw new Error('spawn blew up');
      }
      const child = new FakeChild();
      child.hangOnTerm = hang.on;
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    fetch: (async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.endsWith('/health')) {
        return decideFetch(post.mode, init?.signal);
      }
      health.probes += 1;
      await health.hold;
      if (!health.ok) {
        throw new Error('down');
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      if (ms === POLL_MS) {
        clock.now += POLL_MS;
        return Promise.resolve();
      }
      delays.push(ms);
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { ms, resolve, reject };
        waiting.push(waiter);
        signal?.addEventListener('abort', () => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) {
            waiting.splice(at, 1);
          }
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };
  const engine = new SupervisedEngine(makeSpec(timeoutSeconds), tempPaths(), deps);
  return { engine, children, delays, waiting, clock, health, post, fakeFreePort, fakeSpawn, hang };
}

/** Release the oldest pending sleep with this delay. */
async function release(h: Harness, ms: number): Promise<void> {
  const at = h.waiting.findIndex((w) => w.ms === ms);
  assert.ok(at >= 0, `no pending sleep of ${String(ms)} ms`);
  const [waiter] = h.waiting.splice(at, 1);
  waiter?.resolve();
  await settle();
}

async function startHealthy(h: Harness): Promise<void> {
  h.health.ok = true;
  await h.engine.start();
  assert.equal(h.engine.health().state, 'ready');
}

function live(h: Harness): FakeChild[] {
  return h.children.filter((c) => c.exitCode === null && c.signalCode === null);
}

describe('SupervisedEngine start failure', () => {
  it('kills a child that never became healthy and clears it', async () => {
    const baseline = trackedChildCount();
    const h = harness();
    const done = h.engine.start();
    await settle();
    await done;
    assert.equal(h.engine.health().state, 'failed');
    assert.match(h.engine.health().detail ?? '', /did not become healthy/);
    assert.equal(h.children.length, 1);
    assert.deepEqual(h.children[0]?.signals, ['SIGTERM']);
    assert.equal(trackedChildCount(), baseline);
    await h.engine.stop();
  });

  it('escalates to SIGKILL after the grace when the child ignores SIGTERM', async () => {
    const baseline = trackedChildCount();
    const h = harness();
    h.hang.on = true;
    await h.engine.start();
    await settle();
    assert.deepEqual(h.children[0]?.signals, ['SIGTERM']);
    assert.equal(trackedChildCount(), baseline + 1);
    await release(h, GRACE_MS);
    assert.deepEqual(h.children[0]?.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(trackedChildCount(), baseline);
  });

  it('is failed, not rejected, when spawn throws or freePort rejects', async () => {
    const h = harness();
    h.fakeSpawn.fail = true;
    await h.engine.start();
    assert.equal(h.engine.health().state, 'failed');
    assert.match(h.engine.health().detail ?? '', /spawn blew up/);

    const g = harness();
    g.fakeFreePort.fail = true;
    await g.engine.start();
    assert.equal(g.engine.health().state, 'failed');
    assert.match(g.engine.health().detail ?? '', /no port/);
  });
});

describe('SupervisedEngine start idempotence', () => {
  it('makes one spawn for two concurrent start() calls and returns one promise', async () => {
    const h = harness();
    h.health.ok = true;
    const first = h.engine.start();
    const second = h.engine.start();
    assert.equal(first, second);
    await first;
    assert.equal(h.children.length, 1);
    assert.equal(h.engine.health().state, 'ready');
    await h.engine.stop();
  });

  it('does nothing when ready', async () => {
    const h = harness();
    await startHealthy(h);
    await h.engine.start();
    assert.equal(h.children.length, 1);
    await h.engine.stop();
  });

  it('spawns nothing within the failed cooldown and one child after it', async () => {
    const h = harness();
    const done = h.engine.start();
    await settle();
    await done;
    assert.equal(h.engine.health().state, 'failed');
    assert.equal(h.children.length, 1);

    h.clock.now += 59_000;
    await h.engine.start();
    assert.equal(h.children.length, 1);
    assert.equal(h.engine.health().state, 'failed');

    h.clock.now += 2000;
    h.health.ok = true;
    await h.engine.start();
    assert.equal(h.children.length, 2);
    assert.equal(h.engine.health().state, 'ready');
    await h.engine.stop();
  });

  it('spawns nothing extra on load() or ensureReady() during the restart backoff', async () => {
    const h = harness();
    await startHealthy(h);
    const managed = new ManagedEngine(h.engine, { lifecycle: 'eager', idleUnloadMinutes: 0 });
    h.health.ok = false;
    h.children[0]!.die(1, null);
    assert.equal(h.engine.health().state, 'starting');
    assert.equal(h.waiting.length, 1);

    const loading = managed.load();
    void managed.ensureReady(AbortSignal.timeout(50)).catch(() => undefined);
    await settle();
    assert.equal(h.children.length, 1);

    h.health.ok = true;
    await release(h, 2000);
    await loading;
    assert.equal(h.children.length, 2);
    assert.equal(h.engine.health().state, 'ready');
    await h.engine.stop();
  });
});

describe('SupervisedEngine output hints', () => {
  const TORCH_ERROR =
    'Traceback (most recent call last):\nAssertionError: Torch not compiled with CUDA enabled\n';

  it('adds a remedy to the exit detail and the decision error', async () => {
    const h = harness();
    await startHealthy(h);
    h.children[0]!.stderr.write(TORCH_ERROR);
    await settle();
    h.children[0]!.die(1, null);
    assert.match(h.engine.health().detail ?? '', /engine exited \(code 1\): torch has no CUDA/);
    assert.match(h.engine.health().detail ?? '', /--flavor cuda/);
    await assert.rejects(
      h.engine.decide(REQUEST, AbortSignal.timeout(1000)),
      /engine starting \(torch has no CUDA support/,
    );
    await h.engine.stop();
  });

  it('says nothing extra for an exit without a known cause', async () => {
    const h = harness();
    await startHealthy(h);
    h.children[0]!.die(1, null);
    assert.equal(h.engine.health().detail, 'engine exited (code 1); restart 1');
    await assert.rejects(
      h.engine.decide(REQUEST, AbortSignal.timeout(1000)),
      (error: Error) => error.message === 'engine starting',
    );
    await h.engine.stop();
  });
});

describe('SupervisedEngine stop and orphans', () => {
  it('drops the old backoff timer when stop() then start() runs inside the window', async () => {
    const h = harness();
    await startHealthy(h);
    h.children[0]!.die(1, null);
    assert.equal(h.waiting.length, 1);

    await h.engine.stop();
    assert.equal(h.engine.health().state, 'stopped');
    await h.engine.start();
    assert.equal(h.children.length, 2);
    await settle();
    assert.equal(live(h).length, 1);
    assert.equal(h.engine.health().state, 'ready');
    await h.engine.stop();
  });

  it("ignores an orphan's late exit", async () => {
    const h = harness();
    h.hang.on = true;
    await h.engine.start(); // failed: child 0 was told to stop but is still running
    h.hang.on = false;

    h.clock.now += 61_000;
    h.health.ok = true;
    await h.engine.start();
    assert.equal(h.engine.health().state, 'ready');
    assert.equal(h.children.length, 2);

    h.children[0]!.die(1, null);
    await settle();
    assert.equal(h.engine.health().state, 'ready');
    assert.equal(h.children.length, 2);
    assert.equal(h.waiting.filter((w) => w.ms !== GRACE_MS).length, 0);
    assert.equal(live(h).length, 1);
    await h.engine.stop();
  });
});

describe('SupervisedEngine crash budget', () => {
  it('backs off 2/4/8/16/32 s and gives up on the sixth exit', async () => {
    const h = harness();
    await startHealthy(h);
    for (let i = 1; i <= 5; i += 1) {
      h.health.ok = false;
      h.children.at(-1)!.die(1, null);
      assert.equal(h.engine.health().state, 'starting');
      h.health.ok = true;
      await release(h, 2000 * 2 ** (i - 1));
      assert.equal(h.engine.health().state, 'ready');
      assert.equal(h.children.length, i + 1);
    }
    assert.deepEqual(h.delays, [2000, 4000, 8000, 16_000, 32_000]);
    h.children.at(-1)!.die(1, null);
    assert.equal(h.engine.health().state, 'failed');
    assert.match(h.engine.health().detail ?? '', /giving up after 5 restarts/);
    await h.engine.stop();
  });

  it('restarts with a fresh budget after a run longer than the stable window', async () => {
    const h = harness();
    await startHealthy(h);
    for (let i = 0; i < 3; i += 1) {
      h.children.at(-1)!.die(1, null);
      await release(h, 2000 * 2 ** i);
    }
    h.clock.now += 6 * 60_000;
    h.children.at(-1)!.die(1, null);
    assert.equal(h.engine.health().state, 'starting');
    await release(h, 2000);
    assert.equal(h.engine.health().state, 'ready');
    assert.equal(h.delays.at(-1), 2000);
    await h.engine.stop();
  });

  it('fails without an unhandled rejection when the restart throws', async () => {
    const rejections: unknown[] = [];
    const spy = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', spy);
    try {
      const h = harness();
      await startHealthy(h);
      h.fakeSpawn.fail = true;
      h.children[0]!.die(1, null);
      await release(h, 2000);
      assert.equal(h.engine.health().state, 'failed');
      assert.match(h.engine.health().detail ?? '', /spawn blew up/);

      const g = harness();
      await startHealthy(g);
      g.fakeFreePort.fail = true;
      g.children[0]!.die(1, null);
      await release(g, 2000);
      assert.equal(g.engine.health().state, 'failed');
      await settle();
      assert.equal(rejections.length, 0);
    } finally {
      process.off('unhandledRejection', spy);
    }
  });
});

async function readyHarness(): Promise<Harness> {
  const h = harness();
  await startHealthy(h);
  h.health.probes = 0;
  return h;
}

/** Holds every `/health` answer until the returned function is called. */
function holdHealth(h: Harness): () => void {
  const gate = Promise.withResolvers<void>();
  h.health.hold = gate.promise;
  return gate.resolve;
}

describe('SupervisedEngine hang probe', () => {
  it('terminates and restarts after 3 timeouts when /health is silent', async () => {
    const h = await readyHarness();
    h.health.ok = false;
    for (let i = 0; i < 3; i += 1) {
      await decide(h, 'timeout');
    }
    assert.equal(h.health.probes, 1);
    assert.deepEqual(h.children[0]?.signals, ['SIGTERM']);
    assert.equal(h.engine.health().state, 'starting');
    h.health.ok = true;
    await release(h, 2000);
    assert.equal(h.children.length, 2);
    assert.equal(h.engine.health().state, 'ready');
    assert.deepEqual(h.engine.counters(), { engineRestarts: 1, engineHangs: 1 });
    await h.engine.stop();
    assert.deepEqual(h.engine.counters(), { engineRestarts: 1, engineHangs: 1 }, 'stop keeps them');
  });

  it('does not restart when /health answers, and resets the counter', async () => {
    const h = await readyHarness();
    for (let i = 0; i < 3; i += 1) {
      await decide(h, 'timeout');
    }
    assert.equal(h.health.probes, 1);
    assert.deepEqual(h.children[0]?.signals, []);
    assert.equal(h.engine.health().state, 'ready');
    assert.match(h.engine.health().detail ?? '', /slow: 3 consecutive decision timeouts/);
    assert.deepEqual(h.engine.counters(), { engineRestarts: 0, engineHangs: 0 });
    await decide(h, 'timeout');
    await decide(h, 'timeout');
    assert.equal(h.health.probes, 1);
    await h.engine.stop();
  });

  it('counts only decision-deadline timeouts that no answer interrupted', async () => {
    const h = await readyHarness();
    await decide(h, 'abort');
    await decide(h, 'abort');
    h.post.mode = 'busy';
    await decide(h, 'engine');
    await decide(h, 'engine');
    await decide(h, 'abort');
    assert.equal(h.health.probes, 0);
    await decide(h, 'timeout');
    await decide(h, 'timeout');
    h.post.mode = 'ok';
    await decide(h, 'engine');
    await decide(h, 'timeout');
    await decide(h, 'timeout');
    assert.equal(h.health.probes, 0);
    await h.engine.stop();
  });

  it('runs one probe while an earlier probe is still pending', async () => {
    const h = await readyHarness();
    const open = holdHealth(h);
    for (let i = 0; i < 5; i += 1) {
      await decide(h, 'timeout');
    }
    assert.equal(h.health.probes, 1);
    open();
    await settle();
    await h.engine.stop();
  });

  it('ignores a stale probe after stop()', async () => {
    const h = await readyHarness();
    h.health.ok = false;
    const open = holdHealth(h);
    for (let i = 0; i < 3; i += 1) {
      await decide(h, 'timeout');
    }
    await h.engine.stop();
    open();
    await settle();
    assert.equal(h.engine.health().state, 'stopped');
    assert.deepEqual(h.children[0]?.signals, ['SIGTERM']);
    assert.equal(h.children.length, 1);
  });
});
