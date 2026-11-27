import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitUntilUp } from '../shared/poll.ts';

/** A fake clock: `sleep` advances `now` without waiting. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe('waitUntilUp', () => {
  it('returns at once when the gateway already answers', async () => {
    const c = clock();
    assert.equal(await waitUntilUp(async () => true, c), true);
    assert.deepEqual(c.slept, []);
  });

  it('keeps checking through failures and errors until it answers', async () => {
    const c = clock();
    const answers = [false, 'throw', false, true];
    const up = async (): Promise<boolean> => {
      const next = answers.shift();
      if (next === 'throw') throw new Error('connection refused');
      return next === true;
    };
    assert.equal(await waitUntilUp(up, { ...c, stepMs: 500 }), true);
    assert.deepEqual(c.slept, [500, 500, 500]);
  });

  it('gives up after the timeout', async () => {
    const c = clock();
    let checks = 0;
    const up = async (): Promise<boolean> => {
      checks += 1;
      return false;
    };
    assert.equal(await waitUntilUp(up, { ...c, timeoutMs: 2000, stepMs: 500 }), false);
    assert.equal(checks, 5);
    assert.ok(c.now() <= 2000);
  });
});
