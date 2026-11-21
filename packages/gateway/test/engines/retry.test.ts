import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTransientError,
  isUnreachable,
  withTransientRetry,
  type RetrySleep,
} from '../../src/engines/retry.ts';
import { EngineError } from '../../src/engines/types.ts';

const unreachable = (): EngineError => new EngineError('engine unreachable: ECONNREFUSED');
const http = (status: number, path = '/v1/systemone'): EngineError =>
  new EngineError(`engine HTTP ${String(status)}: x`, { status, path, body: 'x' });

function recorder(): { delays: number[]; sleep: RetrySleep } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/** A call that fails with each error in turn, then succeeds. */
function flaky(errors: readonly Error[]): { calls: () => number; call: () => Promise<string> } {
  let n = 0;
  return {
    calls: () => n,
    call: () => {
      const error = errors[n];
      n += 1;
      return error === undefined ? Promise.resolve('ok') : Promise.reject(error);
    },
  };
}

describe('transient classification', () => {
  it('retries unreachable and HTTP 500/502/504 only', () => {
    assert.ok(isUnreachable(unreachable()));
    for (const status of [500, 502, 504]) {
      assert.ok(isTransientError(http(status)), String(status));
    }
    for (const status of [400, 401, 422, 503]) {
      assert.ok(!isTransientError(http(status)), String(status));
    }
    assert.ok(!isTransientError(new EngineError('engine returned invalid JSON')));
    assert.ok(!isTransientError(new EngineError('engine response has no answers')));
    assert.ok(!isTransientError(new EngineError('engine response too large')));
  });
});

describe('withTransientRetry', () => {
  it('retries twice with 250 then 500 ms backoff and returns the success', async () => {
    const { delays, sleep } = recorder();
    const f = flaky([unreachable(), http(502)]);
    assert.equal(await withTransientRetry(f.call, undefined, { sleep }), 'ok');
    assert.equal(f.calls(), 3);
    assert.deepEqual(delays, [250, 500]);
  });

  it('gives up with the last error after two retries', async () => {
    const { delays, sleep } = recorder();
    const f = flaky([unreachable(), unreachable(), http(500), unreachable()]);
    await assert.rejects(withTransientRetry(f.call, undefined, { sleep }), /HTTP 500/);
    assert.equal(f.calls(), 3);
    assert.deepEqual(delays, [250, 500]);
  });

  it('does not retry busy 503, 4xx or bad bodies', async () => {
    for (const error of [http(503), http(400), new EngineError('engine returned invalid JSON')]) {
      const { delays, sleep } = recorder();
      const f = flaky([error]);
      await assert.rejects(withTransientRetry(f.call, undefined, { sleep }));
      assert.equal(f.calls(), 1);
      assert.deepEqual(delays, []);
    }
  });

  it('does not retry once the signal is aborted', async () => {
    const { sleep } = recorder();
    const controller = new AbortController();
    controller.abort();
    const f = flaky([unreachable()]);
    await assert.rejects(withTransientRetry(f.call, controller.signal, { sleep }));
    assert.equal(f.calls(), 1);
  });

  it('stops with no further call when aborted during the backoff', async () => {
    const controller = new AbortController();
    const f = flaky([unreachable(), unreachable()]);
    const sleep: RetrySleep = (_ms, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        queueMicrotask(() => controller.abort());
      });
    await assert.rejects(
      withTransientRetry(f.call, controller.signal, { sleep }),
      (error: Error) => error.name === 'AbortError',
    );
    assert.equal(f.calls(), 1);
  });

  it('honours a custom predicate', async () => {
    const { sleep } = recorder();
    const f = flaky([http(500)]);
    await assert.rejects(
      withTransientRetry(f.call, undefined, { sleep, isTransient: isUnreachable }),
    );
    assert.equal(f.calls(), 1);
  });
});
