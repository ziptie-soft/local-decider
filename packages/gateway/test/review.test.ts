import type { LogRecord, OutcomeRecord, ShadowRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENGINE_BUSY_ERROR } from '../src/engines/types.ts';
import { computeReview, formatReview, type ReviewOptions } from '../src/review.ts';
import { makeShadowRecord } from './records.ts';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const OPTIONS: ReviewOptions = { days: 7, limit: 50, now: NOW };

function answers(answer: string): ShadowRecord['answers'] {
  return {
    verdict: {
      type: 'choice',
      answer,
      probabilities: { allow: 0.2, ask: 0.2, deny: 0.2, [answer]: 0.6 },
      confidence: 0.6,
    },
  };
}

const decision = (id: string, answer: string, extra: Partial<ShadowRecord> = {}): ShadowRecord =>
  makeShadowRecord(id, {
    ts: '2026-11-21T10:00:00.000Z',
    answers: answers(answer),
    action: answer === 'allow' ? 'allow' : 'ask',
    ...extra,
  });

const label = (id: string, outcome: string, extra: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  kind: 'outcome',
  ts: '2026-11-21T10:00:05.000Z',
  decisionId: id,
  outcome,
  source: 'user',
  verified: true,
  ...extra,
});

const unverified = (
  id: string,
  outcome: string,
  claimed: 'user' | 'classifier' = 'user',
): OutcomeRecord =>
  label(id, outcome, { source: 'unverified', verified: false, claimedSource: claimed });

function classes(
  records: LogRecord[],
  options: Partial<ReviewOptions> = {},
): Record<string, string> {
  const result = computeReview(records, new Map(), { ...OPTIONS, ...options });
  return Object.fromEntries(result.disagreements.map((row) => [row.decisionId, row.class]));
}

describe('computeReview classes', () => {
  it('lists an allow with a verified veto first, enforced or not', () => {
    const records = [
      decision('enforced', 'allow', { enforced: true }),
      label('enforced', 'unsafe'),
      decision('shadow', 'allow'),
      label('shadow', 'deny'),
    ];
    const result = computeReview(records, new Map(), OPTIONS);
    assert.deepEqual(
      result.disagreements
        .map((r) => [r.decisionId, r.class, r.enforced])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ['enforced', 'allow-vetoed', true],
        ['shadow', 'allow-vetoed', false],
      ],
    );
  });

  it('lists a veto that is also a mismatch once, as the veto', () => {
    const result = computeReview(
      [decision('both', 'allow', { enforced: true }), label('both', 'deny')],
      new Map(),
      OPTIONS,
    );
    assert.equal(result.disagreements.length, 1);
    assert.equal(result.disagreements[0]?.class, 'allow-vetoed');
    assert.equal(result.summary['permission']?.['answer-mismatch'], 0);
  });

  it('lists a would-allow the classifier denied, unless the mod auto-allowed it', () => {
    const records = [
      decision('refused', 'allow'),
      unverified('refused', 'deny', 'classifier'),
      decision('applied', 'allow', { enforced: true }),
      unverified('applied', 'allow', 'classifier'),
    ];
    assert.deepEqual(classes(records), { refused: 'classifier-denied' });
    assert.equal(
      computeReview(
        [decision('v', 'allow'), label('v', 'deny', { source: 'classifier' })],
        new Map(),
        OPTIONS,
      ).disagreements[0]?.class,
      'allow-vetoed',
    );
  });

  it('tags the direction of an answer mismatch', () => {
    const records = [
      decision('held-back', 'ask'),
      label('held-back', 'allow'),
      decision('wrong-way', 'allow', { action: 'ask' }),
      label('wrong-way', 'deny'),
      decision('agrees', 'allow'),
      label('agrees', 'allow'),
    ];
    const result = computeReview(records, new Map(), OPTIONS);
    const byId = Object.fromEntries(result.disagreements.map((r) => [r.decisionId, r]));
    assert.equal(byId['held-back']?.class, 'answer-mismatch');
    assert.equal(byId['held-back']?.direction, 'over-cautious');
    assert.equal(byId['wrong-way']?.direction, 'other');
    assert.equal(byId['agrees'], undefined);
  });

  it('marks unverified mismatches and drops them with verifiedOnly', () => {
    const records = [
      decision('claimed', 'ask'),
      unverified('claimed', 'allow'),
      decision('both-kinds', 'ask'),
      unverified('both-kinds', 'allow'),
      label('both-kinds', 'ask'),
    ];
    const result = computeReview(records, new Map(), OPTIONS);
    assert.deepEqual(classes(records), { claimed: 'unverified-mismatch' });
    assert.equal(result.disagreements[0]?.verified, false);
    assert.deepEqual(classes(records, { verifiedOnly: true }), {});
  });

  it('never counts neutral outcomes, unjudged errors or probes', () => {
    const records = [
      decision('declined', 'allow', { enforced: true }),
      label('declined', 'decline'),
      decision('busy', 'allow', { error: ENGINE_BUSY_ERROR }),
      label('busy', 'unsafe'),
      decision('probe', 'allow', { harness: 'mcp' }),
      label('probe', 'unsafe'),
      decision('cli', 'allow', { harness: 'cli' }),
      label('cli', 'unsafe'),
    ];
    assert.deepEqual(classes(records), {});
  });

  it('lets a decline be corrected to a veto, but never a verified allow', () => {
    const records = [
      decision('corrected', 'allow'),
      label('corrected', 'decline'),
      label('corrected', 'unsafe'),
      decision('final', 'allow'),
      label('final', 'allow'),
      label('final', 'unsafe'),
    ];
    assert.deepEqual(classes(records), { corrected: 'allow-vetoed' });
  });

  it('flags truncated decisions and filters by policy and scope', () => {
    const records = [
      decision('cut', 'allow', { truncated: ['Request'], scope: 'claude-auto' }),
      label('cut', 'deny'),
      decision('other', 'allow', { policy: 'command-risk' }),
      label('other', 'deny'),
    ];
    const all = computeReview(records, new Map(), OPTIONS);
    assert.equal(all.disagreements.find((r) => r.decisionId === 'cut')?.truncated, true);
    assert.deepEqual(classes(records, { policy: 'command-risk' }), { other: 'allow-vetoed' });
    assert.deepEqual(classes(records, { scope: 'claude-auto' }), { cut: 'allow-vetoed' });
  });
});

describe('computeReview output', () => {
  const many: LogRecord[] = [
    decision('mm-old', 'ask', { ts: '2026-11-20T00:00:00.000Z' }),
    label('mm-old', 'allow'),
    decision('veto-old', 'allow', { ts: '2026-11-19T00:00:00.000Z' }),
    label('veto-old', 'unsafe'),
    decision('veto-new', 'allow', { ts: '2026-11-21T00:00:00.000Z' }),
    label('veto-new', 'unsafe'),
    decision('clean', 'allow'),
    label('clean', 'allow'),
  ];

  it('orders by class, then newest first, and counts what the limit cuts', () => {
    const result = computeReview(many, new Map(), { ...OPTIONS, limit: 2 });
    assert.deepEqual(
      result.disagreements.map((r) => r.decisionId),
      ['veto-new', 'veto-old'],
    );
    assert.equal(result.omitted, 1);
    assert.deepEqual(result.summary['permission'], {
      'allow-vetoed': 2,
      'classifier-denied': 0,
      'answer-mismatch': 1,
      'unverified-mismatch': 0,
    });
  });

  it('has the window and a stable JSON shape for X8', () => {
    const result = computeReview(many, new Map(), OPTIONS);
    assert.deepEqual(Object.keys(result), ['window', 'summary', 'disagreements', 'omitted']);
    assert.deepEqual(result.window, {
      days: 7,
      from: '2026-11-15T12:00:00.000Z',
      to: '2026-11-22T12:00:00.000Z',
    });
  });

  it('formats a header, counts per policy and one line per row ending with its id', () => {
    const lines = formatReview(computeReview(many, new Map(), OPTIONS)).split('\n');
    assert.match(lines[0] ?? '', /^review: last 7 days .*: 3 disagreements$/);
    assert.equal(lines[1], '  permission: allow-vetoed 2 · answer-mismatch 1');
    assert.match(lines[2] ?? '', / veto-new$/);
    assert.match(
      lines[2] ?? '',
      /allow-vetoed permission allow model allow 0\.60 → unsafe \(user, verified\)/,
    );
    assert.equal(lines.at(-1), 'explain one: local-decider explain <id>');
  });

  it('reads as empty when nothing disagrees', () => {
    assert.match(formatReview(computeReview([], new Map(), OPTIONS)), /: 0 disagreements$/);
  });
});
