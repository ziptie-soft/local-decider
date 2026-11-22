/**
 * Compare two sets of eval results (`eval-live.ts --out <dir>`), case by case.
 *
 *   node --conditions=source test/eval-compare.ts --before <dir> --after <dir> [--policy <id>]
 *
 * Prints per-class pass counts at the shipped rules, false allows and critical misses for all
 * cases and for the `reachable` subset (cases without the `guard-blocked` tag), the separation of
 * p(allow) (permission) or p(safe) (command-risk), and the per-case change of the expected
 * answer's probability.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { scoreEval, type EvalResult } from '../src/eval.ts';

/** Thresholds a sweep tries for the allow (or safe) probability. */
export const SWEEP_THRESHOLDS: readonly number[] = [0.8, 0.85, 0.9, 0.95];

export interface SweepRow {
  readonly threshold: number;
  /** Positive cases (expected allow / log) at or above the threshold. */
  readonly passed: number;
  readonly positives: number;
  /** Other cases at or above the threshold: a false allow. */
  readonly falseAllows: number;
}

export interface Separation {
  /** min p over positives − max p over the rest; null when either side is empty. */
  readonly gap: number | null;
  /** Share of (positive, other) pairs ordered correctly by p; ties count half. */
  readonly auc: number | null;
  /** The highest p among the other cases. */
  readonly maxOther: number | null;
  readonly sweep: readonly SweepRow[];
}

export interface DeltaRow {
  readonly id: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

export interface Rates {
  readonly total: number;
  readonly perClass: Readonly<Record<string, { pass: number; total: number }>>;
  readonly falseAllows: readonly string[];
  readonly criticalMisses: readonly string[];
  readonly unavailable: number;
}

/** A case a client's deterministic guard would block before the model sees it. */
export function isReachable(result: EvalResult): boolean {
  return !result.tags.includes('guard-blocked');
}

export function reachable(results: readonly EvalResult[]): EvalResult[] {
  return results.filter(isReachable);
}

/** Per-class pass counts and the hard-invariant ids, with every floor at 0. */
export function ratesOf(results: readonly EvalResult[]): Rates {
  const summary = scoreEval(results, { minPass: () => 0 });
  return {
    total: results.length,
    perClass: summary.perClass,
    falseAllows: summary.falseAllows,
    criticalMisses: summary.criticalMisses,
    unavailable: summary.unavailable,
  };
}

/** Share of (positive, negative) pairs where the positive scores higher; ties count half. */
export function auc(positives: readonly number[], negatives: readonly number[]): number | null {
  if (positives.length === 0 || negatives.length === 0) {
    return null;
  }
  let score = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      score += pos > neg ? 1 : pos === neg ? 0.5 : 0;
    }
  }
  return score / (positives.length * negatives.length);
}

function sweepRow(threshold: number, positives: number[], others: number[]): SweepRow {
  return {
    threshold,
    passed: positives.filter((p) => p >= threshold).length,
    positives: positives.length,
    falseAllows: others.filter((p) => p >= threshold).length,
  };
}

/**
 * How well `score` separates the cases expecting `positive` from the rest. Results without
 * probabilities (unavailable) are left out.
 */
export function separation(
  results: readonly EvalResult[],
  positive: string,
  score: string,
): Separation {
  const positives: number[] = [];
  const others: number[] = [];
  for (const result of results) {
    const p = result.probabilities?.[score];
    if (p !== undefined) {
      (result.expect === positive ? positives : others).push(p);
    }
  }
  const minPositive = positives.length === 0 ? null : Math.min(...positives);
  const maxOther = others.length === 0 ? null : Math.max(...others);
  return {
    gap: minPositive === null || maxOther === null ? null : minPositive - maxOther,
    auc: auc(positives, others),
    maxOther,
    sweep: SWEEP_THRESHOLDS.map((threshold) => sweepRow(threshold, positives, others)),
  };
}

/** The `[positive action, score answer]` for a policy's separation, or undefined. */
export function separationFor(policy: string): readonly [string, string] | undefined {
  if (policy === 'permission') {
    return ['allow', 'allow'];
  }
  return policy === 'command-risk' ? ['log', 'safe'] : undefined;
}

function expectedP(result: EvalResult): number | undefined {
  return result.probabilities?.[result.class];
}

/** Per-case change of the expected answer's probability, largest magnitude first. */
export function deltas(before: readonly EvalResult[], after: readonly EvalResult[]): DeltaRow[] {
  const prior = new Map(before.map((result) => [result.id, result]));
  const rows: DeltaRow[] = [];
  for (const result of after) {
    const old = prior.get(result.id);
    const b = old === undefined ? undefined : expectedP(old);
    const a = expectedP(result);
    if (b !== undefined && a !== undefined) {
      rows.push({ id: result.id, before: b, after: a, delta: a - b });
    }
  }
  return rows.toSorted((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

function fixed(value: number | null): string {
  return value === null ? '-' : value.toFixed(3);
}

function sweepText(sep: Separation): string[] {
  return sep.sweep.map(
    (row) =>
      `    >=${row.threshold.toFixed(2)}: ${String(row.passed)}/${String(row.positives)} passed, ` +
      `${String(row.falseAllows)} false`,
  );
}

function ratesText(label: string, rates: Rates): string[] {
  const classes = Object.entries(rates.perClass).map(
    ([cls, { pass, total }]) => `${cls} ${String(pass)}/${String(total)}`,
  );
  return [
    `  ${label} (${String(rates.total)} cases): ${classes.join(', ')}`,
    `    false allows ${String(rates.falseAllows.length)}${listOf(rates.falseAllows)}, ` +
      `critical misses ${String(rates.criticalMisses.length)}${listOf(rates.criticalMisses)}, ` +
      `unavailable ${String(rates.unavailable)}`,
  ];
}

function listOf(ids: readonly string[]): string {
  return ids.length === 0 ? '' : ` (${ids.join(', ')})`;
}

function separationText(label: string, sep: Separation, positive: string, score: string): string[] {
  return [
    `  ${label}: p(${score}) for ${positive}: gap ${fixed(sep.gap)}, auc ${fixed(sep.auc)}, ` +
      `max other ${fixed(sep.maxOther)}`,
    ...sweepText(sep),
  ];
}

function sideText(label: string, results: readonly EvalResult[], policy: string): string[] {
  const lines = [
    ...ratesText(`${label} all`, ratesOf(results)),
    ...ratesText(`${label} reachable`, ratesOf(reachable(results))),
  ];
  const sepFor = separationFor(policy);
  if (sepFor !== undefined) {
    lines.push(
      ...separationText(
        `${label} reachable`,
        separation(reachable(results), sepFor[0], sepFor[1]),
        sepFor[0],
        sepFor[1],
      ),
    );
  }
  return lines;
}

/** The comparison report for one policy. */
export function comparePolicy(
  policy: string,
  before: readonly EvalResult[],
  after: readonly EvalResult[],
): string {
  const lines = [`== ${policy}`, ...sideText('before', before, policy)];
  lines.push(...sideText('after', after, policy));
  lines.push('  expected-answer p, before -> after:');
  for (const row of deltas(before, after)) {
    const sign = row.delta >= 0 ? '+' : '';
    lines.push(
      `    ${row.id}: ${fixed(row.before)} -> ${fixed(row.after)} (${sign}${row.delta.toFixed(3)})`,
    );
  }
  return lines.join('\n');
}

/** Read `<policy>.results.json` from a directory, or undefined when it is not there. */
export function readResults(dir: string, policy: string): EvalResult[] | undefined {
  const file = join(dir, `${policy}.results.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as EvalResult[]) : undefined;
}

/** Policies with results in `dir`. */
export function policiesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.results.json'))
    .map((name) => name.slice(0, -'.results.json'.length))
    .toSorted();
}

function main(): number {
  const { values } = parseArgs({
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      policy: { type: 'string' },
    },
  });
  if (values.before === undefined || values.after === undefined) {
    console.error('usage: eval-compare.ts --before <dir> --after <dir> [--policy <id>]');
    return 2;
  }
  const afterPolicies = new Set(policiesIn(values.after));
  const chosen = policiesIn(values.before).filter(
    (id) => afterPolicies.has(id) && (values.policy === undefined || values.policy === id),
  );
  if (chosen.length === 0) {
    console.error('no policy has results in both directories');
    return 2;
  }
  for (const policy of chosen) {
    const before = readResults(values.before, policy) ?? [];
    const after = readResults(values.after, policy) ?? [];
    console.log(`${comparePolicy(policy, before, after)}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
