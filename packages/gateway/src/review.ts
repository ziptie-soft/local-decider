import type {
  LogRecord,
  OutcomeRecord,
  Policy,
  ShadowRecord,
} from '@ziptie-soft/local-decider-core';

import { isUnjudged } from './engine-busy.ts';
import { primaryFor } from './explain.ts';
import { isProbeDecision, isTruncatedDecision } from './log-store.ts';
import {
  comparableOutcome,
  correctedOutcome,
  isVerifiedOutcome,
  outcomeClass,
} from './outcome-labels.ts';
import { labelledAnswer } from './stats.ts';

/** Disagreement classes, most severe first. A decision is listed once, under its first class. */
const REVIEW_CLASSES = [
  'allow-vetoed',
  'classifier-denied',
  'answer-mismatch',
  'unverified-mismatch',
] as const;
export type ReviewClass = (typeof REVIEW_CLASSES)[number];

export const DEFAULT_REVIEW_LIMIT = 50;
export const MAX_REVIEW_LIMIT = 1000;

export interface ReviewOptions {
  readonly days: number;
  readonly policy?: string | undefined;
  readonly scope?: string | undefined;
  readonly limit: number;
  /** Hide `unverified-mismatch` rows. */
  readonly verifiedOnly?: boolean | undefined;
  /** Window end, ms since the epoch; default now. */
  readonly now?: number | undefined;
}

/** Hash-only: ids, hashes-free metadata and answers, never request text. */
export interface ReviewRow {
  readonly ts: string;
  readonly decisionId: string;
  readonly policy: string;
  readonly variant?: string;
  readonly harness: string;
  readonly scope?: string;
  readonly tool?: string;
  readonly action: string;
  readonly enforced: boolean;
  readonly primary?: { question: string; answer: string; confidence: number };
  readonly outcome: string;
  readonly source: string;
  readonly verified: boolean;
  readonly class: ReviewClass;
  readonly truncated: boolean;
  /** `answer-mismatch` only: `over-cautious` (the model held back, the user allowed) or `other`. */
  readonly direction?: 'over-cautious' | 'other';
}

export interface ReviewResult {
  readonly window: { readonly days: number; readonly from: string; readonly to: string };
  /** Per policy, the number of decisions in each class (before `limit`). */
  readonly summary: Readonly<Record<string, Readonly<Record<ReviewClass, number>>>>;
  readonly disagreements: readonly ReviewRow[];
  /** Disagreements found beyond `limit`. */
  readonly omitted: number;
}

interface Facts {
  readonly decision: ShadowRecord;
  readonly outcomes: OutcomeRecord[];
}

interface Hit {
  readonly class: ReviewClass;
  readonly outcome: OutcomeRecord;
  readonly direction?: 'over-cautious' | 'other';
}

const DAY_MS = 86_400_000;
const HELD_BACK = new Set(['deny', 'ask', 'unsure']);

function wanted(decision: ShadowRecord, options: ReviewOptions): boolean {
  return (
    !isProbeDecision(decision) &&
    !isUnjudged(decision.error) &&
    (options.scope === undefined || decision.scope === options.scope) &&
    (options.policy === undefined ||
      decision.policy === options.policy ||
      decision.variant === options.policy)
  );
}

/** Decisions of the window with their outcomes in the order recorded. */
function collect(records: Iterable<LogRecord>, options: ReviewOptions): Map<string, Facts> {
  const facts = new Map<string, Facts>();
  const outcomes: OutcomeRecord[] = [];
  for (const record of records) {
    if (record.kind === 'outcome') {
      outcomes.push(record);
    } else if (record.kind === 'decision' && wanted(record, options)) {
      facts.set(record.decisionId, { decision: record, outcomes: [] });
    }
  }
  for (const outcome of outcomes) {
    facts.get(outcome.decisionId)?.outcomes.push(outcome);
  }
  return facts;
}

/** The verified outcome in force, as precedent folds them (first wins, a decline may become a veto). */
function effectiveRecord(outcomes: readonly OutcomeRecord[]): OutcomeRecord | undefined {
  let current: string | undefined;
  let record: OutcomeRecord | undefined;
  for (const outcome of outcomes.filter(isVerifiedOutcome)) {
    const next = correctedOutcome(current, outcome.outcome);
    if (next !== undefined) {
      current = next;
      record = outcome;
    }
  }
  return record;
}

function vetoedAllow({ decision, outcomes }: Facts): Hit | undefined {
  const outcome = effectiveRecord(outcomes);
  return decision.action === 'allow' &&
    outcome !== undefined &&
    outcomeClass(outcome.outcome) === 'veto'
    ? { class: 'allow-vetoed', outcome }
    : undefined;
}

/** The decider would allow, the mod did not auto-allow it, and the classifier's last word was deny. */
function classifierDenied({ decision, outcomes }: Facts): Hit | undefined {
  if (decision.action !== 'allow' || (decision.enforced && decision.action === 'allow')) {
    return undefined;
  }
  const outcome = outcomes.findLast(
    (o) => o.source === 'classifier' || o.claimedSource === 'classifier',
  );
  return outcome?.outcome === 'deny' ? { class: 'classifier-denied', outcome } : undefined;
}

function mismatch(
  decision: ShadowRecord,
  outcome: OutcomeRecord,
): 'over-cautious' | 'other' | null {
  const value = comparableOutcome(outcome.outcome);
  const answer = value === undefined ? undefined : labelledAnswer(decision, value);
  if (value === undefined || answer === undefined || answer.answer === value) {
    return null;
  }
  return value === 'allow' && HELD_BACK.has(answer.answer) ? 'over-cautious' : 'other';
}

function comparable(
  outcomes: readonly OutcomeRecord[],
  verified: boolean,
): OutcomeRecord | undefined {
  const found = verified
    ? effectiveRecord(outcomes)
    : outcomes.findLast((o) => !isVerifiedOutcome(o));
  return found !== undefined && comparableOutcome(found.outcome) !== undefined ? found : undefined;
}

/** The latest verified label differs from the model's answer; else the latest unverified one does. */
function mismatches({ decision, outcomes }: Facts, verifiedOnly: boolean): Hit | undefined {
  const verified = comparable(outcomes, true);
  if (verified !== undefined) {
    const direction = mismatch(decision, verified);
    return direction === null
      ? undefined
      : { class: 'answer-mismatch', outcome: verified, direction };
  }
  const unverified = verifiedOnly ? undefined : comparable(outcomes, false);
  const direction = unverified === undefined ? null : mismatch(decision, unverified);
  return unverified === undefined || direction === null
    ? undefined
    : { class: 'unverified-mismatch', outcome: unverified };
}

function classify(facts: Facts, verifiedOnly: boolean): Hit | undefined {
  return vetoedAllow(facts) ?? classifierDenied(facts) ?? mismatches(facts, verifiedOnly);
}

function rowOf(decision: ShadowRecord, hit: Hit, policy: Policy | undefined): ReviewRow {
  const primary = primaryFor(decision, policy);
  return {
    ts: decision.ts,
    decisionId: decision.decisionId,
    policy: decision.policy,
    ...(decision.variant === undefined ? {} : { variant: decision.variant }),
    harness: decision.harness,
    ...(decision.scope === undefined ? {} : { scope: decision.scope }),
    ...(decision.tool === undefined ? {} : { tool: decision.tool }),
    action: decision.action,
    enforced: decision.enforced,
    ...(primary === undefined
      ? {}
      : {
          primary: {
            question: primary.question,
            answer: primary.answer,
            confidence: primary.confidence,
          },
        }),
    outcome: hit.outcome.outcome,
    source: hit.outcome.source,
    verified: isVerifiedOutcome(hit.outcome),
    class: hit.class,
    truncated: isTruncatedDecision(decision),
    ...(hit.direction === undefined ? {} : { direction: hit.direction }),
  };
}

function emptySummary(): Record<ReviewClass, number> {
  return {
    'allow-vetoed': 0,
    'classifier-denied': 0,
    'answer-mismatch': 0,
    'unverified-mismatch': 0,
  };
}

const bySeverity = (a: ReviewRow, b: ReviewRow): number =>
  REVIEW_CLASSES.indexOf(a.class) - REVIEW_CLASSES.indexOf(b.class) || b.ts.localeCompare(a.ts);

/**
 * The decisions the user's labels or the classifier contradict, worst first. Pure: `records` is
 * the stats window (probes already out), `policies` only names each row's primary question.
 */
export function computeReview(
  records: Iterable<LogRecord>,
  policies: ReadonlyMap<string, { readonly policy: Policy }>,
  options: ReviewOptions,
): ReviewResult {
  const to = options.now ?? Date.now();
  const summary: Record<string, Record<ReviewClass, number>> = {};
  const rows: ReviewRow[] = [];
  for (const facts of collect(records, options).values()) {
    const { decision } = facts;
    const counts = (summary[decision.policy] ??= emptySummary());
    const hit = classify(facts, options.verifiedOnly === true);
    if (hit !== undefined) {
      counts[hit.class] += 1;
      rows.push(rowOf(decision, hit, policies.get(decision.variant ?? decision.policy)?.policy));
    }
  }
  const sorted = rows.toSorted(bySeverity);
  return {
    window: {
      days: options.days,
      from: new Date(to - options.days * DAY_MS).toISOString(),
      to: new Date(to).toISOString(),
    },
    summary,
    disagreements: sorted.slice(0, options.limit),
    omitted: Math.max(0, sorted.length - options.limit),
  };
}

function rowLine(row: ReviewRow): string {
  const answer =
    row.primary === undefined
      ? ''
      : ` model ${row.primary.answer} ${row.primary.confidence.toFixed(2)} →`;
  const trust = row.verified ? 'verified' : 'unverified';
  const flags = [row.truncated ? 'truncated' : undefined, row.direction].filter(
    (x) => x !== undefined,
  );
  return [
    row.ts.slice(0, 19) + 'Z',
    row.class,
    row.policy,
    row.tool,
    `${row.action}${row.enforced ? ' (enforced)' : ''}`,
  ]
    .filter((x) => x !== undefined)
    .join(' ')
    .concat(`${answer} ${row.outcome} (${row.source}, ${trust})`)
    .concat(flags.length === 0 ? '' : ` [${flags.join(', ')}]`)
    .concat(` ${row.decisionId}`);
}

/** A header with the counts per policy and class, then one line per row ending with its id. */
export function formatReview(result: ReviewResult): string {
  const { window, summary, disagreements, omitted } = result;
  const total = disagreements.length + omitted;
  const lines = [
    `review: last ${String(window.days)} days (${window.from.slice(0, 10)} to ${window.to.slice(0, 10)}): ${String(total)} disagreements`,
  ];
  for (const [policy, counts] of Object.entries(summary).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parts = REVIEW_CLASSES.filter((c) => counts[c] > 0).map(
      (c) => `${c} ${String(counts[c])}`,
    );
    lines.push(`  ${policy}: ${parts.length === 0 ? 'none' : parts.join(' · ')}`);
  }
  lines.push(...disagreements.map(rowLine));
  if (omitted > 0) {
    lines.push(`… ${String(omitted)} more (raise --limit)`);
  }
  if (total > 0) {
    lines.push('explain one: local-decider explain <id>');
  }
  return lines.join('\n');
}
