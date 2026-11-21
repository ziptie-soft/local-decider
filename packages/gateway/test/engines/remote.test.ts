import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SystemOneRemoteEngine } from '../../src/engines/remote.ts';

const REQUEST = { state: 's', questions: { q: { type: 'noul' as const, instructions: 'i' } } };
const OK_BODY = '{"answers":{"q":{"type":"noul","noul":0.9}}}';

type PostStep = 'unreachable' | 'ok' | number;

interface Rig {
  readonly engine: SystemOneRemoteEngine;
  readonly clock: { now: number };
  readonly health: { ok: boolean; probes: number };
  readonly posts: () => number;
  readonly delays: number[];
}

function rig(steps: PostStep[]): Rig {
  const clock = { now: 0 };
  const health = { ok: true, probes: 0 };
  const delays: number[] = [];
  let posts = 0;
  const fetchFake = ((url: string): Promise<Response> => {
    if (url.endsWith('/health')) {
      health.probes += 1;
      return health.ok
        ? Promise.resolve(new Response('{}', { status: 200 }))
        : Promise.reject(new Error('down'));
    }
    posts += 1;
    const step = steps.shift() ?? 'ok';
    if (step === 'unreachable') {
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    return Promise.resolve(
      step === 'ok' ? new Response(OK_BODY) : new Response('err', { status: step }),
    );
  }) as unknown as typeof fetch;
  const engine = new SystemOneRemoteEngine(
    { type: 'systemone-remote', url: 'http://127.0.0.1:9', model: 'm' },
    {},
    {
      fetch: fetchFake,
      now: () => clock.now,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    },
  );
  return { engine, clock, health, posts: () => posts, delays };
}

const decide = (r: Rig, signal = AbortSignal.timeout(5000)): ReturnType<typeof r.engine.decide> =>
  r.engine.decide(REQUEST, signal);

describe('SystemOneRemoteEngine retry', () => {
  it('retries an unreachable error once and stays ready', async () => {
    const r = rig(['unreachable', 'ok']);
    await r.engine.start();
    await decide(r);
    assert.equal(r.posts(), 2);
    assert.deepEqual(r.delays, [250]);
    assert.equal(r.engine.health().state, 'ready');
  });

  it('does not retry a busy 503 and stays ready', async () => {
    const r = rig([503]);
    await r.engine.start();
    await assert.rejects(decide(r));
    assert.equal(r.posts(), 1);
    assert.equal(r.engine.health().state, 'ready');
  });

  it('does not retry a 400', async () => {
    const r = rig([400]);
    await r.engine.start();
    await assert.rejects(decide(r), /HTTP 400/);
    assert.equal(r.posts(), 1);
    assert.equal(r.engine.health().state, 'ready');
  });

  it('flips to failed after 3 transport failures when /health is silent', async () => {
    const r = rig(['unreachable', 'unreachable', 'unreachable']);
    await r.engine.start();
    r.health.ok = false;
    await assert.rejects(decide(r), /unreachable/);
    assert.equal(r.posts(), 3);
    assert.equal(r.engine.health().state, 'failed');
  });

  it('stays ready after 3 transport failures when /health answers', async () => {
    const r = rig(['unreachable', 'unreachable', 'unreachable']);
    await r.engine.start();
    await assert.rejects(decide(r), /unreachable/);
    assert.equal(r.engine.health().state, 'ready');
  });

  it('makes no further fetch when aborted before the retry', async () => {
    const r = rig(['unreachable', 'ok']);
    await r.engine.start();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decide(r, controller.signal));
    assert.equal(r.posts(), 1);
    assert.equal(r.engine.health().state, 'ready');
  });
});

describe('SystemOneRemoteEngine recheck throttle', () => {
  it('start() from failed within 5 s of the last probe does nothing', async () => {
    const r = rig([]);
    r.health.ok = false;
    await r.engine.start();
    assert.equal(r.engine.health().state, 'failed');
    assert.equal(r.health.probes, 1);

    r.clock.now += 4000;
    await r.engine.start();
    assert.equal(r.health.probes, 1);

    r.clock.now += 2000;
    r.health.ok = true;
    await r.engine.start();
    assert.equal(r.health.probes, 2);
    assert.equal(r.engine.health().state, 'ready');
  });
});
