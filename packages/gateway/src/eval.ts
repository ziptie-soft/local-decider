import type { DecideRequest, DecideResponse } from '@ziptie-soft/local-decider-core';
import { z } from 'zod';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const EvalCaseSchema = z.object({
  id: z.string().regex(SLUG).optional(),
  tags: z.array(z.string().regex(SLUG)).optional(),
  input: z.record(z.string(), z.unknown()),
  expect: z.string(),
  answer: z.string().optional(),
  critical: z.boolean().optional(),
});

export interface PolicyEvalCase {
  readonly input: DecideRequest['input'];
  readonly expect: string;
  readonly id?: string;
  readonly tags?: readonly string[];
  /** Expected top answer of the policy's single question; the scoring class when present. */
  readonly answer?: string;
  /** A miss on this case is a safety failure. */
  readonly critical?: boolean;
}

export type EvalDecide = (policy: string, request: DecideRequest) => Promise<DecideResponse | null>;

export type EvalStatus = 'ok' | 'miss' | 'unavailable';

export interface EvalResult {
  readonly id: string;
  readonly class: string;
  readonly expect: string;
  readonly action: string;
  readonly answer?: string;
  readonly probability: number | null;
  readonly status: EvalStatus;
  readonly tags: readonly string[];
  readonly critical: boolean;
}

export interface EvalFloors {
  /** The minimum pass rate in [0, 1] for one case class. */
  readonly minPass: (cls: string) => number;
}

export interface Tally {
  pass: number;
  total: number;
}

export interface EvalSummary {
  readonly perClass: Readonly<Record<string, Tally>>;
  readonly perTag: Readonly<Record<string, Tally>>;
  readonly falseAllows: readonly string[];
  readonly criticalMisses: readonly string[];
  readonly unavailable: number;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

/** Thrown when the policy is in `off` mode: it abstains without asking the engine. */
export class EvalPolicyOffError extends Error {
  readonly policy: string;
  constructor(policy: string) {
    super(`policy ${policy} is off; set it to shadow or act to evaluate it`);
    this.name = 'EvalPolicyOffError';
    this.policy = policy;
  }
}

/** Parse JSONL eval cases, identifying malformed lines for CLI users. Unknown keys are stripped. */
export function parseEvalCases(source: string, file = '<eval>'): PolicyEvalCase[] {
  const cases: PolicyEvalCase[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    const where = `${file}:${String(index + 1)}`;
    cases.push(parseEvalLine(text, where));
  }
  return cases;
}

function parseEvalLine(text: string, where: string): PolicyEvalCase {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${where}: invalid JSON`);
  }
  const parsed = EvalCaseSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new Error(
      `${where}: expected { input: object, expect: string, id?, tags?, answer?, critical? }` +
        (path === '' ? '' : ` (bad ${path}: ${issue?.message ?? 'invalid'})`),
    );
  }
  const { id, tags, input, expect, answer, critical } = parsed.data;
  return {
    input,
    expect,
    ...(id === undefined ? {} : { id }),
    ...(tags === undefined ? {} : { tags }),
    ...(answer === undefined ? {} : { answer }),
    ...(critical === undefined ? {} : { critical }),
  };
}

function formatResult(index: number, result: EvalResult): string {
  const p = result.probability === null ? '-' : result.probability.toFixed(3);
  const status = result.status === 'miss' ? 'MISS' : result.status;
  return `${String(index + 1)} ${result.id} expected=${result.expect} action=${result.action} p=${p} ${status}`;
}

function resultFor(
  testCase: PolicyEvalCase,
  index: number,
  response: DecideResponse | null,
): EvalResult {
  const first = response === null ? undefined : Object.values(response.answers)[0];
  const probability = first === undefined ? null : (first.probabilities[first.answer] ?? 0);
  const failed = response === null || response.error !== undefined;
  const action = failed ? 'unavailable' : response.action;
  const status: EvalStatus = failed ? 'unavailable' : action === testCase.expect ? 'ok' : 'miss';
  return {
    id: testCase.id ?? String(index + 1),
    class: testCase.answer ?? testCase.expect,
    expect: testCase.expect,
    action,
    ...(first === undefined ? {} : { answer: first.answer }),
    probability,
    status,
    tags: testCase.tags ?? [],
    critical: testCase.critical === true,
  };
}

/**
 * Decide each fixture and return one result per case. A thrown decide or an engine error counts as
 * `unavailable`; a policy in `off` mode throws `EvalPolicyOffError`. With the default `report`,
 * one line per case is printed.
 */
export async function runPolicyEval(
  policy: string,
  cases: readonly PolicyEvalCase[],
  decide: EvalDecide,
  report: (line: string) => void = console.log,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    const response = await decisionOrNull(decide, policy, testCase.input);
    if (response?.mode === 'off') {
      throw new EvalPolicyOffError(policy);
    }
    const result = resultFor(testCase, index, response);
    results.push(result);
    report(formatResult(index, result));
  }
  return results;
}

async function decisionOrNull(
  decide: EvalDecide,
  policy: string,
  input: DecideRequest['input'],
): Promise<DecideResponse | null> {
  try {
    return await decide(policy, { harness: 'cli', input });
  } catch {
    return null;
  }
}

function tally(target: Record<string, Tally>, key: string, result: EvalResult): void {
  const entry = (target[key] ??= { pass: 0, total: 0 });
  entry.total += 1;
  if (result.status === 'ok') {
    entry.pass += 1;
  }
}

function tallies(results: readonly EvalResult[]): {
  perClass: Record<string, Tally>;
  perTag: Record<string, Tally>;
} {
  const perClass: Record<string, Tally> = {};
  const perTag: Record<string, Tally> = {};
  for (const result of results) {
    tally(perClass, result.class, result);
    for (const tag of result.tags) {
      tally(perTag, tag, result);
    }
  }
  return { perClass, perTag };
}

function falseAllowIds(results: readonly EvalResult[]): string[] {
  return results
    .filter((r) => r.action === 'allow' && r.expect !== 'allow')
    .map((result) => result.id);
}

function escalates(action: string): boolean {
  return action === 'ask' || action === 'deny';
}

/**
 * A critical miss fails to escalate: the case expects `ask` or `deny` and the action is neither.
 * Answering `ask` where `deny` was expected keeps a human in the loop, so it is an ordinary miss.
 */
function criticalMissIds(results: readonly EvalResult[]): string[] {
  return results
    .filter((r) => r.critical && r.status === 'miss' && escalates(r.expect) && !escalates(r.action))
    .map((result) => result.id);
}

function floorFailures(perClass: Readonly<Record<string, Tally>>, floors: EvalFloors): string[] {
  const failures: string[] = [];
  for (const [cls, { pass, total }] of Object.entries(perClass)) {
    const floor = floors.minPass(cls);
    if (pass / total < floor) {
      failures.push(
        `class ${cls}: ${String(pass)}/${String(total)} is below the ${floor.toFixed(2)} floor`,
      );
    }
  }
  return failures;
}

function invariantFailures(
  results: readonly EvalResult[],
  falseAllows: readonly string[],
  criticalMisses: readonly string[],
  unavailable: number,
): string[] {
  const failures: string[] = [];
  if (results.length === 0) {
    failures.push('no cases');
  }
  if (falseAllows.length > 0) {
    failures.push(`false allow: ${falseAllows.join(', ')}`);
  }
  if (criticalMisses.length > 0) {
    failures.push(`critical miss: ${criticalMisses.join(', ')}`);
  }
  if (unavailable > 0) {
    failures.push(`${String(unavailable)} case(s) unavailable`);
  }
  return failures;
}

/** Score results by class and tag, and check the floors and the hard invariants. */
export function scoreEval(results: readonly EvalResult[], floors: EvalFloors): EvalSummary {
  const { perClass, perTag } = tallies(results);
  const falseAllows = falseAllowIds(results);
  const criticalMisses = criticalMissIds(results);
  const unavailable = results.filter((r) => r.status === 'unavailable').length;
  const failures = [
    ...invariantFailures(results, falseAllows, criticalMisses, unavailable),
    ...floorFailures(perClass, floors),
  ];
  return {
    perClass,
    perTag,
    falseAllows,
    criticalMisses,
    unavailable,
    failures,
    passed: failures.length === 0,
  };
}

function tallyLines(label: string, counts: Readonly<Record<string, Tally>>): string[] {
  return Object.entries(counts).map(
    ([key, { pass, total }]) => `${label} ${key}: ${String(pass)}/${String(total)}`,
  );
}

/** Per-class and per-tag lines, then `PASS` or `FAIL` with each broken rule. */
export function formatEvalSummary(summary: EvalSummary): string {
  const lines = [...tallyLines('class', summary.perClass), ...tallyLines('tag', summary.perTag)];
  if (summary.passed) {
    lines.push('PASS');
  } else {
    lines.push('FAIL', ...summary.failures.map((failure) => `  - ${failure}`));
  }
  return lines.join('\n');
}
