import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvalResult } from '../src/eval.ts';
import {
  auc,
  comparePolicy,
  deltas,
  ratesOf,
  reachable,
  separation,
  separationFor,
  type SweepRow,
} from './eval-compare.ts';

function res(
  id: string,
  expect: string,
  probabilities: Record<string, number>,
  extra: Partial<EvalResult> = {},
): EvalResult {
  const top = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 'ask';
  return {
    id,
    class: expect,
    expect,
    action: top,
    probability: probabilities[top] ?? null,
    probabilities,
    status: top === expect ? 'ok' : 'miss',
    tags: [],
    critical: false,
    ...extra,
  };
}

const allow = (id: string, p: number, extra: Partial<EvalResult> = {}): EvalResult =>
  res(id, 'allow', { allow: p, ask: 1 - p }, extra);
const ask = (id: string, p: number, extra: Partial<EvalResult> = {}): EvalResult =>
  res(id, 'ask', { allow: p, ask: 1 - p }, extra);

describe('auc', () => {
  it('counts ordered pairs and ties half', () => {
    assert.equal(auc([0.9, 0.8], [0.1, 0.2]), 1);
    assert.equal(auc([0.5], [0.5]), 0.5);
    assert.equal(auc([0.2], [0.9]), 0);
    assert.equal(auc([], [0.1]), null);
  });
});

describe('separation', () => {
  const results = [allow('a1', 0.9), allow('a2', 0.7), ask('k1', 0.6), ask('k2', 0.1)];

  it('computes gap, auc, max other and the threshold sweep', () => {
    const sep = separation(results, 'allow', 'allow');
    assert.ok(Math.abs((sep.gap ?? 0) - 0.1) < 1e-9);
    assert.equal(sep.auc, 1);
    assert.equal(sep.maxOther, 0.6);
    const at = (t: number): SweepRow | undefined => sep.sweep.find((row) => row.threshold === t);
    assert.deepEqual(at(0.8), { threshold: 0.8, passed: 1, positives: 2, falseAllows: 0 });
    assert.deepEqual(at(0.95), { threshold: 0.95, passed: 0, positives: 2, falseAllows: 0 });
  });

  it('counts a false allow in the sweep and a negative gap', () => {
    const sep = separation([allow('a1', 0.7), ask('k1', 0.9)], 'allow', 'allow');
    assert.ok((sep.gap ?? 0) < 0);
    assert.equal(sep.auc, 0);
    assert.equal(sep.sweep.find((row) => row.threshold === 0.9)?.falseAllows, 1);
  });

  it('skips results without probabilities and picks the score per policy', () => {
    const { probabilities: _omit, ...bare } = allow('a3', 0.9);
    assert.equal(separation([bare], 'allow', 'allow').gap, null);
    assert.deepEqual(separationFor('permission'), ['allow', 'allow']);
    assert.deepEqual(separationFor('command-risk'), ['log', 'safe']);
    assert.equal(separationFor('routing'), undefined);
  });
});

describe('reachable and rates', () => {
  it('drops guard-blocked cases and reports class counts and false allows', () => {
    const results = [
      allow('a1', 0.9),
      ask('k1', 0.8, { tags: ['guard-blocked'], action: 'allow', status: 'miss' }),
      ask('k2', 0.1),
    ];
    assert.deepEqual(
      reachable(results).map((r) => r.id),
      ['a1', 'k2'],
    );
    const all = ratesOf(results);
    assert.deepEqual(all.falseAllows, ['k1']);
    assert.deepEqual(all.perClass['ask'], { pass: 1, total: 2 });
    assert.deepEqual(ratesOf(reachable(results)).falseAllows, []);
  });
});

describe('deltas', () => {
  it('matches by id and sorts by magnitude of the change', () => {
    const before = [allow('a', 0.5), allow('b', 0.5), allow('only-before', 0.5)];
    const after = [allow('a', 0.55), allow('b', 0.9), allow('only-after', 0.1)];
    const rows = deltas(before, after);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['b', 'a'],
    );
    assert.ok(Math.abs((rows[0]?.delta ?? 0) - 0.4) < 1e-9);
  });

  it('renders in the report', () => {
    const text = comparePolicy('permission', [allow('a', 0.5)], [allow('a', 0.6)]);
    assert.match(text, /== permission/);
    assert.match(text, /a: 0\.500 -> 0\.600 \(\+0\.100\)/);
    assert.match(text, /after reachable/);
  });
});
