import type { LogStore } from './log-store.ts';
import type { LoadedPolicy } from './policies.ts';
import { computeReview, DEFAULT_REVIEW_LIMIT, MAX_REVIEW_LIMIT } from './review.ts';
import { parseDays } from './stats-job.ts';

/** The window the HTTP route reads in-process; longer reviews use `local-decider review`. */
const MAX_REVIEW_DAYS = 30;

/** What `GET /v1/review` reads: the store, the policies in force and the retention bound. */
export interface ReviewSource {
  readonly log: LogStore;
  readonly policies: ReadonlyMap<string, LoadedPolicy>;
  readonly retainDays: number;
}

export type ReviewHttpResult = readonly [status: number, body: unknown];

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return DEFAULT_REVIEW_LIMIT;
  }
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  return limit >= 1 && limit <= MAX_REVIEW_LIMIT ? limit : undefined;
}

/**
 * Pure of HTTP: the status and JSON body of `GET /v1/review?days=N&limit=N`, the same hash-only
 * result as `local-decider review --json`. The caller has already checked the control token.
 */
export function reviewResponse(source: ReviewSource, params: URLSearchParams): ReviewHttpResult {
  const window = parseDays(params.get('days'), Math.min(source.retainDays, MAX_REVIEW_DAYS));
  if ('error' in window) {
    return [400, { error: window.error }];
  }
  const limit = parseLimit(params.get('limit'));
  if (limit === undefined) {
    return [400, { error: `limit must be an integer from 1 to ${String(MAX_REVIEW_LIMIT)}` }];
  }
  const records = [...source.log.iterateRecent(window.days)];
  return [200, computeReview(records, source.policies, { days: window.days, limit })];
}
