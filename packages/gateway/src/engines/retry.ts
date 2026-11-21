import { setTimeout as timerSleep } from 'node:timers/promises';

import { EngineError } from './types.ts';

/** Retries after the first attempt. */
const REMOTE_RETRIES = 2;
/** Backoff before retry `i` is `REMOTE_RETRY_BASE_MS * 2 ** i`: 250 ms, then 500 ms. */
const REMOTE_RETRY_BASE_MS = 250;

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 504]);

export type RetrySleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  readonly sleep?: RetrySleep;
  /** Which errors are worth another attempt; defaults to {@link isTransientError}. */
  readonly isTransient?: (error: unknown) => boolean;
}

/** The request never reached a server (connection refused, DNS, reset): no model ran. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof EngineError && error.message.startsWith('engine unreachable:');
}

/** Unreachable, or HTTP 500/502/504. Never the busy 503, a 4xx, bad JSON or a missing answer. */
export function isTransientError(error: unknown): boolean {
  if (isUnreachable(error)) {
    return true;
  }
  const status = error instanceof EngineError ? error.httpFailure?.status : undefined;
  return status !== undefined && TRANSIENT_STATUSES.has(status);
}

/**
 * Runs `call`, retrying transient failures up to {@link REMOTE_RETRIES} times with backoff.
 * An aborted `signal` stops at once, and aborts the wait between attempts. Only for calls
 * that are safe to repeat (`/v1/systemone` is read-only).
 */
export async function withTransientRetry<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
): Promise<T> {
  const sleep: RetrySleep =
    options.sleep ?? ((ms, s) => timerSleep(ms, undefined, s === undefined ? {} : { signal: s }));
  const isTransient = options.isTransient ?? isTransientError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= REMOTE_RETRIES || signal?.aborted === true || !isTransient(error)) {
        throw error;
      }
      await sleep(REMOTE_RETRY_BASE_MS * 2 ** attempt, signal);
    }
  }
}
