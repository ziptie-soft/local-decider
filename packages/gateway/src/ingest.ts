/** Validation and rate limiting for the outcome and usage ingestion routes (S6). */
import type { ShadowRecord } from '@ziptie-soft/local-decider-core';

/** Outcome values with fixed meanings (`outcome-labels.ts`), valid for any decision. */
const FIXED_OUTCOMES: ReadonlySet<string> = new Set([
  'allow',
  'deny',
  'unsafe',
  'decline',
  'interrupted',
]);

/** Unverified posts per minute and burst allowed on each ingestion route. */
export const UNVERIFIED_PER_MINUTE = 60;
export const UNVERIFIED_BURST = 30;

/** Whether `outcome` is a fixed label or an answer label of one of the decision's questions. */
export function validOutcome(decision: ShadowRecord, outcome: string): boolean {
  if (FIXED_OUTCOMES.has(outcome)) {
    return true;
  }
  return Object.values(decision.answers).some((answer) =>
    Object.hasOwn(answer.probabilities, outcome),
  );
}

/** A small in-memory token bucket: `burst` tokens, refilled at `perMinute`. */
export class TokenBucket {
  readonly #burst: number;
  readonly #perMs: number;
  #tokens: number;
  #last: number;

  constructor(perMinute: number, burst: number, now = Date.now()) {
    this.#burst = burst;
    this.#perMs = perMinute / 60_000;
    this.#tokens = burst;
    this.#last = now;
  }

  /** Take one token; false when the bucket is empty. */
  take(now = Date.now()): boolean {
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + Math.max(0, now - this.#last) * this.#perMs,
    );
    this.#last = now;
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}
