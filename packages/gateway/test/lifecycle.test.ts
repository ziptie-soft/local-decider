import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ManagedEngine } from '../src/engines/lazy.ts';
import { FakeEngine } from './helpers.ts';

const REQ = { state: 's', questions: { q: { type: 'noul' as const, instructions: 'i' } } };

/** Starts after `delayMs`, like a real model load. */
class SlowStart extends FakeEngine {
  starts = 0;
  readonly delayMs: number;
  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
    this.state = 'stopped';
    this.respond = () => ({ answers: { q: { type: 'noul', noul: 0.9 } } });
  }
  override async start(): Promise<void> {
    this.starts += 1;
    this.state = 'starting';
    await sleep(this.delayMs);
    this.state = 'ready';
  }
}

describe('ManagedEngine', () => {
  it('lazy: does not load at start, loads on the first decision and waits for it', async () => {
    const inner = new SlowStart(50);
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.start();
    assert.equal(inner.starts, 0);
    assert.equal(engine.health().onDemand, true);
    assert.match(engine.health().detail ?? '', /loads on the next decision/);
    const res = await engine.decide(REQ, AbortSignal.timeout(2000));
    assert.equal(res.answers['q']?.type, 'noul');
    assert.equal(inner.starts, 1);
    assert.ok(engine.lastUsedAt !== null);
    await engine.stop();
  });

  it('lazy: a decision gives up when its own signal fires during the load', async () => {
    const engine = new ManagedEngine(new SlowStart(500), {
      lifecycle: 'lazy',
      idleUnloadMinutes: 15,
    });
    await assert.rejects(engine.decide(REQ, AbortSignal.timeout(50)), /timeout|aborted/i);
    await engine.stop();
  });

  it('eager: loads at start and reports a stopped engine as down, not on demand', async () => {
    const inner = new SlowStart(10);
    const engine = new ManagedEngine(inner, { lifecycle: 'eager', idleUnloadMinutes: 15 });
    await engine.start();
    assert.equal(inner.starts, 1);
    await engine.unload();
    assert.equal(engine.health().onDemand, undefined);
  });

  it('unloads on request and reloads on the next decision', async () => {
    const inner = new SlowStart(10);
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.load();
    await engine.unload('idle');
    assert.match(engine.health().detail ?? '', /unloaded after 15 min idle/);
    await engine.decide(REQ, AbortSignal.timeout(2000));
    assert.equal(inner.starts, 2);
    await engine.stop();
  });

  it('defers idle unload while a decision is in flight and arms it afterwards', async () => {
    const inner = new SlowStart(0);
    inner.respond = async () => {
      await sleep(150);
      return { answers: { q: { type: 'noul', noul: 0.9 } } };
    };
    // 0.001 min = 60 ms: shorter than the decision.
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 0.001 });
    await engine.load();
    await engine.decide(REQ, AbortSignal.timeout(2000));
    assert.equal(inner.health().state, 'ready', 'not unloaded mid-request');
    await sleep(150);
    assert.equal(inner.health().state, 'stopped', 'unloaded once idle');
    await engine.stop();
  });

  it('drain waits for in-flight decisions and is bounded', async () => {
    const inner = new SlowStart(0);
    let release: (() => void) | undefined;
    inner.respond = () =>
      new Promise((resolve) => {
        release = () => resolve({ answers: { q: { type: 'noul', noul: 0.9 } } });
      });
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.load();
    const running = engine.decide(REQ, AbortSignal.timeout(2000));
    await sleep(10);
    let drained = false;
    const waiting = engine.drain(2000).then(() => {
      drained = true;
    });
    await sleep(30);
    assert.equal(drained, false);
    release?.();
    await running;
    await waiting;
    assert.equal(drained, true);
    const stuck = engine.decide(REQ, AbortSignal.timeout(2000));
    await sleep(10);
    const started = Date.now();
    await engine.drain(40);
    assert.ok(Date.now() - started < 1000, 'gave up after the timeout');
    release?.();
    await stuck;
    await engine.stop();
  });

  it('a drain that timed out does not disturb a later drain', async () => {
    const inner = new SlowStart(0);
    let release: (() => void) | undefined;
    inner.respond = () =>
      new Promise((resolve) => {
        release = () => resolve({ answers: { q: { type: 'noul', noul: 0.9 } } });
      });
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await engine.load();
    const running = engine.decide(REQ, AbortSignal.timeout(2000));
    await sleep(10);
    await engine.drain(20);
    let later = false;
    const waiting = engine.drain(2000).then(() => {
      later = true;
    });
    await sleep(20);
    assert.equal(later, false);
    release?.();
    await running;
    await waiting;
    assert.equal(later, true);
    await engine.stop();
  });

  it('fails fast when the engine cannot load', async () => {
    const inner = new FakeEngine();
    inner.state = 'stopped';
    inner.start = async (): Promise<void> => {
      inner.state = 'failed';
    };
    const engine = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
    await assert.rejects(engine.decide(REQ, AbortSignal.timeout(2000)), /engine failed/);
  });
});
