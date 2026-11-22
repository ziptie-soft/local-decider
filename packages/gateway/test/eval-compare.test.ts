import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvalResult } from '../src/eval.ts';
import {
  argmaxSweep,
  type ArgmaxRow,
  auc,
  comparePolicy,
  deltas,
  falsePasses,
  ratesOf,
  reachable,
  routeDirection,
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

describe('falsePasses', () => {
  it('counts a non-critical ask that logs and ignores an ask answered deny', () => {
    const logged = ask('k1', 0.4, { action: 'log', status: 'miss' });
    const denied = ask('k2', 0.1, { action: 'deny', status: 'miss' });
    const asked = ask('k3', 0.1, { action: 'ask' });
    const unavailable = ask('k4', 0.1, { action: 'unavailable', status: 'unavailable' });
    const positive = allow('a1', 0.9, { action: 'log', status: 'miss' });
    assert.deepEqual(falsePasses([logged, denied, asked, unavailable, positive]), ['k1']);
    assert.deepEqual(ratesOf([logged, denied]).falsePasses, ['k1']);
  });
});

const route = (id: string, cls: string, to: string): EvalResult =>
  res(id, cls, { [to]: 0.7 }, { class: cls, expect: `route:${cls}`, action: `route:${to}` });

describe('routeDirection', () => {
  it('finds under-routes and over-routes on a 3-tier fixture', () => {
    const results = [
      route('deep-as-fast', 'deep', 'fast'),
      route('deep-as-standard', 'deep', 'standard'),
      route('fast-as-deep', 'fast', 'deep'),
      route('fast-ok', 'fast', 'fast'),
      route('std-as-fast', 'standard', 'fast'),
    ];
    assert.deepEqual(routeDirection('routing', results), {
      underRoutes: ['deep-as-fast'],
      overRoutes: ['fast-as-deep'],
    });
    const budget = [route('p', 'premium', 'cheap'), route('c', 'cheap', 'premium')];
    assert.deepEqual(routeDirection('routing-budget', budget), {
      underRoutes: ['p'],
      overRoutes: ['c'],
    });
    assert.equal(routeDirection('permission', results), undefined);
  });
});

const three = (id: string, cls: string, p: Record<string, number>): EvalResult =>
  res(id, cls, p, { class: cls });

describe('argmaxSweep', () => {
  it('counts wrong-class hits only when the class is the argmax', () => {
    const results = [
      three('f1', 'fast', { fast: 0.7, standard: 0.2, deep: 0.1 }),
      three('f2', 'fast', { fast: 0.45, standard: 0.4, deep: 0.15 }),
      three('s1', 'standard', { fast: 0.6, standard: 0.3, deep: 0.1 }),
      three('s2', 'standard', { fast: 0.5, standard: 0.45, deep: 0.05 }),
    ];
    const rows = argmaxSweep(results)['fast'] ?? [];
    const at = (t: number): ArgmaxRow | undefined => rows.find((row) => row.threshold === t);
    assert.deepEqual(at(0.4)?.wrongHits, ['s1', 's2']);
    assert.equal(at(0.4)?.passed, 2);
    assert.equal(at(0.55)?.passed, 1);
    assert.deepEqual(at(0.55)?.wrongHits, ['s1']);
    assert.deepEqual(at(0.7)?.wrongHits, []);
    assert.equal(rows.length, 12);
    assert.ok(Math.abs((at(0.55)?.confidence ?? 0) - 0.325) < 1e-9);
    assert.equal(argmaxSweep(results)['standard']?.[0]?.passed, 0);
  });
});
