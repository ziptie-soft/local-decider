import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DailyReview, type Schedule } from '../server/review.ts';
import { parseReview, REVIEW_ROWS, reviewChecked, reviewHeadline } from '../shared/review.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: { days: 1, from: '2026-11-21T00:00:00.000Z', to: '2026-11-22T00:00:00.000Z' },
    summary: {
      'permission': { 'allow-vetoed': 1, 'classifier-denied': 2 },
      'turn-outcome': { 'answer-mismatch': 1 },
    },
    disagreements: [
      {
        decisionId: 'd-1',
        class: 'allow-vetoed',
        policy: 'permission',
        tool: 'Bash',
        ts: '2026-11-21T10:00:00.000Z',
        // Anything beyond hashes and ids must not survive parsing.
        input: 'SECRET-TEXT',
      },
    ],
    omitted: 3,
    ...overrides,
  };
}

/** A scheduler a test steps by hand. */
function manual(): { schedule: Schedule; pending: () => number[]; fire: () => void } {
  const timers: { ms: number; run: () => void; live: boolean }[] = [];
  return {
    schedule: (run, ms) => {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    pending: () => timers.filter((t) => t.live).map((t) => t.ms),
    fire: () => {
      const next = timers.find((t) => t.live);
      if (next !== undefined) {
        next.live = false;
        next.run();
      }
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('parseReview', () => {
  it('reduces the gateway body to counts and a few hash-only rows', () => {
    const review = parseReview(body());
    assert.ok(review !== null);
    assert.equal(review.total, 4);
    assert.deepEqual(review.counts, {
      'allow-vetoed': 1,
      'classifier-denied': 2,
      'answer-mismatch': 1,
      'unverified-mismatch': 0,
    });
    assert.deepEqual(review.policies, [
      { policy: 'permission', total: 3 },
      { policy: 'turn-outcome', total: 1 },
    ]);
    assert.equal(review.rows[0]?.tool, 'Bash');
    assert.ok(!JSON.stringify(review).includes('SECRET-TEXT'));
  });

  it('bounds the rows and clips long text', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      decisionId: `d-${String(i)}`.padEnd(200, 'x'),
      class: 'answer-mismatch',
      policy: 'p'.repeat(500),
      ts: '2026-11-21T10:00:00.000Z',
    }));
    const review = parseReview(body({ disagreements: rows, omitted: 0 }));
    assert.ok(review !== null);
    assert.equal(review.rows.length, REVIEW_ROWS);
    assert.equal(review.total, 20);
    assert.ok(review.rows.every((row) => row.decisionId.length <= 64 && row.policy.length <= 64));
    assert.equal(review.rows[0]?.tool, null);
  });

  it('rejects a body that is not a review', () => {
    assert.equal(parseReview(null), null);
    assert.equal(parseReview({ hello: 1 }), null);
    assert.equal(parseReview(body({ disagreements: [{ decisionId: 'd', class: 'nope' }] })), null);
  });
});

describe('reviewHeadline and reviewChecked', () => {
  it('says when nothing disagreed, and counts classes worst first otherwise', () => {
    const none = parseReview(body({ summary: {}, disagreements: [], omitted: 0 }));
    assert.ok(none !== null);
    assert.equal(reviewHeadline(none), 'No disagreements in the last 24 h');
    const some = parseReview(body());
    assert.ok(some !== null);
    assert.equal(
      reviewHeadline(some),
      '4 disagreements in the last 24 h: 1 allow-vetoed · 2 classifier-denied · 1 answer-mismatch',
    );
  });

  it('reports a check that has not happened', () => {
    assert.equal(reviewChecked(null, Date.now()), 'Not checked yet');
  });
});

describe('DailyReview', () => {
  it('is off by default: nothing is scheduled and nothing is fetched', async () => {
    const gw = fakeGateway(() => null);
    const clock = manual();
    const review = new DailyReview(deps(settings(), gw), { schedule: clock.schedule });
    review.setEnabled(false);
    await settle();
    assert.deepEqual(clock.pending(), []);
    assert.equal(gw.reviewCalls.length, 0);
    assert.deepEqual(review.view(), { enabled: false, checkedAt: null, review: null });
  });

  it('checks after the first delay, then every day, asking for one day and a few rows', async () => {
    const gw = fakeGateway(() => null);
    gw.reviewBody = async () => body();
    const clock = manual();
    const d = deps(settings({ dailyReview: true }), gw);
    const review = new DailyReview(d, {
      schedule: clock.schedule,
      now: () => new Date('2026-11-22T08:00:00.000Z'),
    });
    review.setEnabled(true);
    assert.equal(clock.pending().length, 1);
    clock.fire();
    await settle();
    assert.deepEqual(gw.reviewCalls, [{ days: 1, limit: REVIEW_ROWS }]);
    assert.equal(review.view().checkedAt, '2026-11-22T08:00:00.000Z');
    assert.equal(review.view().review?.total, 4);
    assert.deepEqual(clock.pending(), [24 * 60 * 60_000]);
    assert.deepEqual(d.logs, ['daily review: 4 disagreement(s) in 1 d']);
  });

  it('fails quietly when the gateway is down and retries later', async () => {
    const gw = fakeGateway(() => null);
    const clock = manual();
    const d = deps(settings({ dailyReview: true }), gw);
    const review = new DailyReview(d, { schedule: clock.schedule });
    review.setEnabled(true);
    clock.fire();
    await settle();
    assert.equal(review.view().review, null);
    assert.deepEqual(d.logs, []);
    assert.deepEqual(clock.pending(), [60 * 60_000]);

    gw.reviewBody = async () => {
      throw new Error('boom');
    };
    clock.fire();
    await settle();
    assert.deepEqual(d.logs, []);
    assert.equal(clock.pending().length, 1);
  });

  it('keeps the last good review when a later check fails', async () => {
    const gw = fakeGateway(() => null);
    gw.reviewBody = async () => body();
    const clock = manual();
    const review = new DailyReview(deps(settings(), gw), { schedule: clock.schedule });
    review.setEnabled(true);
    clock.fire();
    await settle();
    gw.reviewBody = async () => null;
    clock.fire();
    await settle();
    assert.equal(review.view().review?.total, 4);
  });

  it('turning it off cancels the timer and drops the data', async () => {
    const gw = fakeGateway(() => null);
    gw.reviewBody = async () => body();
    const clock = manual();
    const review = new DailyReview(deps(settings(), gw), { schedule: clock.schedule });
    review.setEnabled(true);
    clock.fire();
    await settle();
    review.setEnabled(false);
    assert.deepEqual(clock.pending(), []);
    assert.deepEqual(review.view(), { enabled: false, checkedAt: null, review: null });
  });

  it('ignores a fetch that finishes after it was turned off', async () => {
    const gw = fakeGateway(() => null);
    const gate = Promise.withResolvers<unknown>();
    gw.reviewBody = () => gate.promise;
    const clock = manual();
    const d = deps(settings(), gw);
    const review = new DailyReview(d, { schedule: clock.schedule });
    review.setEnabled(true);
    clock.fire();
    await settle();
    review.setEnabled(false);
    gate.resolve(body());
    await settle();
    assert.deepEqual(clock.pending(), []);
    assert.equal(review.view().review, null);
    assert.deepEqual(d.logs, []);
  });

  it('stop() ends the timer for good', async () => {
    const clock = manual();
    const review = new DailyReview(
      deps(
        settings(),
        fakeGateway(() => null),
      ),
      {
        schedule: clock.schedule,
      },
    );
    review.setEnabled(true);
    review.stop();
    assert.deepEqual(clock.pending(), []);
    assert.equal(review.view().enabled, false);
  });

  it('does not touch the gateway when none is configured', async () => {
    const clock = manual();
    const d = { ...deps(settings(), null) };
    const review = new DailyReview(d, { schedule: clock.schedule });
    review.setEnabled(true);
    clock.fire();
    await settle();
    assert.deepEqual(d.logs, []);
    assert.equal(clock.pending().length, 1);
  });
});
