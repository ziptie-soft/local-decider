import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openaiCompatibleEngine, OpenAICompatibleEngine } from '../../src/engines/openai/index.ts';

const REQUEST = {
  state: 'safe',
  questions: { ready: { type: 'noul' as const, instructions: 'Is it ready?' } },
};

const GOOD = JSON.stringify({
  choices: [
    {
      logprobs: {
        content: [
          {
            top_logprobs: [
              { token: 'yes', logprob: Math.log(0.8) },
              { token: 'no', logprob: Math.log(0.2) },
            ],
          },
        ],
      },
    },
  ],
});

type Step = 'unreachable' | 'hang' | 'ok' | number;

interface Rig {
  readonly engine: OpenAICompatibleEngine;
  readonly posts: () => number;
}

/** The first POST (the start probe) always succeeds; later ones follow `steps`. */
async function readyRig(steps: Step[], values: Record<string, unknown> = {}): Promise<Rig> {
  let posts = 0;
  const doFetch: typeof fetch = (_input, init) => {
    posts += 1;
    const step = posts === 1 ? 'ok' : (steps.shift() ?? 'ok');
    if (step === 'unreachable') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (step === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    return Promise.resolve(
      step === 'ok' ? new Response(GOOD) : new Response('err', { status: step }),
    );
  };
  const config = openaiCompatibleEngine.configSchema.parse({
    type: 'openai-compatible',
    model: 'm',
    url: 'http://127.0.0.1:9/v1',
    ...values,
  });
  const engine = new OpenAICompatibleEngine(config, {}, doFetch);
  await engine.start();
  assert.equal(engine.health().state, 'ready');
  return { engine, posts: () => posts };
}

const decide = (rig: Rig): ReturnType<Rig['engine']['decide']> =>
  rig.engine.decide(REQUEST, new AbortController().signal);

describe('OpenAI-compatible engine resilience', () => {
  it('retries a transport error and stays ready', async () => {
    const rig = await readyRig(['unreachable', 'ok']);
    await decide(rig);
    assert.equal(rig.posts(), 3); // probe, failed attempt, retry
    assert.equal(rig.engine.health().state, 'ready');
  });

  it('never retries a 5xx and stays ready', async () => {
    for (const status of [500, 502, 503, 504]) {
      const rig = await readyRig([status]);
      await assert.rejects(decide(rig), new RegExp(`HTTP ${String(status)}`));
      assert.equal(rig.posts(), 2, String(status));
      assert.equal(rig.engine.health().state, 'ready', String(status));
    }
  });

  it('stays ready on a 401 or 422', async () => {
    for (const status of [401, 422]) {
      const rig = await readyRig([status]);
      await assert.rejects(decide(rig));
      assert.equal(rig.engine.health().state, 'ready', String(status));
    }
  });

  it('fails only when the transport still fails after the retries', async () => {
    const rig = await readyRig(['unreachable', 'unreachable', 'unreachable']);
    await assert.rejects(decide(rig), /unreachable/);
    assert.equal(rig.posts(), 4);
    assert.equal(rig.engine.health().state, 'failed');
  });

  it('does not retry or flip on a request timeout', async () => {
    const rig = await readyRig(['hang'], { requestTimeoutMs: 1000 });
    await assert.rejects(decide(rig), /timed out/);
    assert.equal(rig.posts(), 2);
    assert.equal(rig.engine.health().state, 'ready');
  });
});
