/** In-memory dedupe and per-agent rate limiting for hook-driven decisions. */

/** Insertion-ordered set that forgets its oldest keys beyond `max`. */
export class BoundedSet {
  readonly #max: number;
  readonly #keys = new Set<string>();

  constructor(max: number) {
    this.#max = max;
  }

  /** Add `key`; false when it was already present. */
  add(key: string): boolean {
    if (this.#keys.has(key)) {
      return false;
    }
    this.#keys.add(key);
    while (this.#keys.size > this.#max) {
      const oldest = this.#keys.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#keys.delete(oldest);
    }
    return true;
  }
}

/** Insertion-ordered map that forgets its oldest entries beyond `max`. */
export class BoundedMap<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  take(key: string): V | undefined {
    const value = this.#map.get(key);
    this.#map.delete(key);
    return value;
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#map.delete(oldest);
    }
  }
}

/**
 * One log line per `intervalMs`, with a count of the lines held back since the last one. The
 * message is `line` as given; when some were suppressed, ` (<n> similar suppressed)` follows.
 */
export class ThrottledLog {
  readonly #intervalMs: number;
  readonly #now: () => number;
  #lastAt = Number.NEGATIVE_INFINITY;
  #suppressed = 0;

  constructor(intervalMs: number, now: () => number = Date.now) {
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  emit(log: (message: string) => void, line: string): void {
    if (this.#now() - this.#lastAt < this.#intervalMs) {
      this.#suppressed += 1;
      return;
    }
    this.#lastAt = this.#now();
    const extra = this.#suppressed > 0 ? ` (${String(this.#suppressed)} similar suppressed)` : '';
    this.#suppressed = 0;
    log(`${line}${extra}`);
  }
}

/** At most `limit` events per `windowMs` per key (sliding window). */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new BoundedMap<number[]>(500);

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** True when `allow(key)` would succeed; records nothing. */
  wouldAllow(key: string): boolean {
    const now = this.#now();
    return (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs).length < this.#limit;
  }

  /** Record an event for `key`; false (and nothing recorded) when over the limit. */
  allow(key: string): boolean {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}

/** A per-key limit plus a global one; an event counts toward both only when both allow it. */
export class DualRateLimiter {
  readonly #perKey: RateLimiter;
  readonly #global: RateLimiter;

  constructor(perKey: number, global: number, windowMs: number, now: () => number = Date.now) {
    this.#perKey = new RateLimiter(perKey, windowMs, now);
    this.#global = new RateLimiter(global, windowMs, now);
  }

  allow(key: string): boolean {
    if (!this.#perKey.wouldAllow(key) || !this.#global.wouldAllow('*')) {
      return false;
    }
    this.#perKey.allow(key);
    this.#global.allow('*');
    return true;
  }
}
