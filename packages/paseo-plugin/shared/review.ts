/**
 * The daily review as the plugin keeps and shows it: `GET /v1/review` reduced to counts and a
 * handful of rows. Hash-only like the gateway's result, and bounded no matter what the gateway
 * sends, so a bad or old gateway cannot grow the plugin's memory or the status screens.
 */
import { z } from 'zod';

import { checkedAgo } from './poll.ts';

/** The gateway's disagreement classes, most severe first (`review.ts` in the gateway). */
const REVIEW_CLASSES = [
  'allow-vetoed',
  'classifier-denied',
  'answer-mismatch',
  'unverified-mismatch',
] as const;

/** Rows asked of the gateway and kept; the rest are only counted. */
export const REVIEW_ROWS = 5;
const REVIEW_POLICIES = 8;
const TEXT_CHARS = 64;

const text = z.string().max(TEXT_CHARS);
const count = z.number().int().min(0);

export const reviewSummarySchema = z.object({
  days: z.number().int().min(1),
  from: z.string().max(40),
  to: z.string().max(40),
  /** Disagreements in the window, including those beyond the rows kept. */
  total: count,
  /** Per class, summed over policies. */
  counts: z.record(z.enum(REVIEW_CLASSES), count),
  /** Policies with at least one disagreement, most first. */
  policies: z.array(z.object({ policy: text, total: count })).max(REVIEW_POLICIES),
  rows: z
    .array(
      z.object({
        decisionId: text,
        class: z.enum(REVIEW_CLASSES),
        policy: text,
        tool: text.nullable(),
        ts: z.string().max(40),
      }),
    )
    .max(REVIEW_ROWS),
});

export type ReviewSummary = z.output<typeof reviewSummarySchema>;

/** What a gateway sends; unknown keys (anything beyond hashes and ids) are dropped on parse. */
const gatewayReview = z.object({
  window: z.object({ days: z.number().int().min(1), from: z.string(), to: z.string() }),
  summary: z.record(z.string(), z.record(z.string(), z.number())),
  disagreements: z.array(
    z.object({
      decisionId: z.string().min(1),
      class: z.enum(REVIEW_CLASSES),
      policy: z.string(),
      tool: z.string().optional(),
      ts: z.string(),
    }),
  ),
  omitted: count,
});

const clip = (value: string): string => value.slice(0, TEXT_CHARS);
const clipTime = (value: string): string => value.slice(0, 40);

function tally(summary: Readonly<Record<string, Readonly<Record<string, number>>>>): {
  counts: ReviewSummary['counts'];
  policies: ReviewSummary['policies'];
} {
  const counts = Object.fromEntries(REVIEW_CLASSES.map((cls) => [cls, 0])) as Record<
    (typeof REVIEW_CLASSES)[number],
    number
  >;
  const policies: { policy: string; total: number }[] = [];
  for (const [policy, perClass] of Object.entries(summary)) {
    let total = 0;
    for (const cls of REVIEW_CLASSES) {
      const n = Math.max(0, Math.trunc(perClass[cls] ?? 0));
      counts[cls] += n;
      total += n;
    }
    if (total > 0) {
      policies.push({ policy: clip(policy), total });
    }
  }
  return {
    counts,
    policies: policies.toSorted((a, b) => b.total - a.total).slice(0, REVIEW_POLICIES),
  };
}

/** The bounded summary of a `GET /v1/review` body, or null when it is not one. */
export function parseReview(body: unknown): ReviewSummary | null {
  const parsed = gatewayReview.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { window, summary, disagreements, omitted } = parsed.data;
  const { counts, policies } = tally(summary);
  return {
    days: window.days,
    from: clipTime(window.from),
    to: clipTime(window.to),
    total: disagreements.length + omitted,
    counts,
    policies,
    rows: disagreements.slice(0, REVIEW_ROWS).map((row) => ({
      decisionId: clip(row.decisionId),
      class: row.class,
      policy: clip(row.policy),
      tool: row.tool === undefined ? null : clip(row.tool),
      ts: clipTime(row.ts),
    })),
  };
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** `No disagreements in the last 24 h`, or the count and its classes, worst first. */
export function reviewHeadline(review: ReviewSummary): string {
  const window = review.days === 1 ? 'the last 24 h' : `the last ${String(review.days)} days`;
  if (review.total === 0) {
    return `No disagreements in ${window}`;
  }
  const classes = REVIEW_CLASSES.filter((cls) => review.counts[cls] > 0).map(
    (cls) => `${String(review.counts[cls])} ${cls}`,
  );
  return `${plural(review.total, 'disagreement')} in ${window}${classes.length === 0 ? '' : `: ${classes.join(' · ')}`}`;
}

/** `Checked 5 min ago`, or that no check has finished yet. */
export function reviewChecked(checkedAt: string | null, now: number): string {
  return checkedAt === null ? 'Not checked yet' : `Checked ${checkedAgo(checkedAt, now)}`;
}
