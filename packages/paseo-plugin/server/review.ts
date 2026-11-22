import { parseReview, REVIEW_ROWS, type ReviewSummary } from '../shared/review.ts';
/**
 * The optional daily review (Settings → "Daily review", off by default). Once a day the plugin
 * server fetches `GET /v1/review?days=1` from the gateway and keeps the bounded, hash-only
 * summary for the status popover and Details page. It runs no agent and no model, and it is
 * read-only. Off means no timer at all; a gateway that is down costs a quiet retry, never a log.
 */
import type { HookDeps } from './deps.ts';

const MINUTE_MS = 60_000;
/** The first check waits a little so it never competes with Paseo starting. */
const FIRST_MS = 30_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RETRY_MS = 60 * MINUTE_MS;
const FETCH_TIMEOUT_MS = 10_000;

/** Schedule `run` once after `ms`; the returned function cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

const unrefTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

export interface ReviewView {
  enabled: boolean;
  checkedAt: string | null;
  review: ReviewSummary | null;
}

export interface ReviewOptions {
  schedule?: Schedule;
  now?: () => Date;
  firstMs?: number;
  everyMs?: number;
  retryMs?: number;
}

export class DailyReview {
  readonly #deps: HookDeps;
  readonly #options: ReviewOptions;
  #cancel: (() => void) | null = null;
  #abort: AbortController | null = null;
  #enabled = false;
  #checkedAt: string | null = null;
  #review: ReviewSummary | null = null;

  constructor(deps: HookDeps, options: ReviewOptions = {}) {
    this.#deps = deps;
    this.#options = options;
  }

  /** Follow the setting: turning it on schedules the first check, off drops timer and data. */
  setEnabled(on: boolean): void {
    if (on === this.#enabled) {
      return;
    }
    this.#enabled = on;
    if (on) {
      this.#arm(this.#options.firstMs ?? FIRST_MS);
      return;
    }
    this.stop();
    this.#checkedAt = null;
    this.#review = null;
  }

  view(): ReviewView {
    return { enabled: this.#enabled, checkedAt: this.#checkedAt, review: this.#review };
  }

  /** Cancel the timer and any fetch in flight. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#enabled = false;
  }

  #arm(ms: number): void {
    this.#cancel?.();
    this.#cancel = (this.#options.schedule ?? unrefTimer)(() => {
      this.#cancel = null;
      void this.#check();
    }, ms);
  }

  async #check(): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    const review = await this.#fetch(abort.signal);
    if (abort.signal.aborted || !this.#enabled) {
      return;
    }
    this.#abort = null;
    if (review === null) {
      this.#arm(this.#options.retryMs ?? RETRY_MS);
      return;
    }
    this.#review = review;
    this.#checkedAt = (this.#options.now?.() ?? new Date()).toISOString();
    this.#deps.log(
      `daily review: ${String(review.total)} disagreement(s) in ${String(review.days)} d`,
    );
    this.#arm(this.#options.everyMs ?? DAY_MS);
  }

  async #fetch(signal: AbortSignal): Promise<ReviewSummary | null> {
    try {
      const gateway = await this.#deps.gateway();
      if (gateway === null) {
        return null;
      }
      return parseReview(
        await gateway.review(1, REVIEW_ROWS, { signal, timeoutMs: FETCH_TIMEOUT_MS }),
      );
    } catch {
      return null;
    }
  }
}
