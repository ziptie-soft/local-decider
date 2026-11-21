/** Decision-path counters owned by one `Decider`. */
export type DecisionCounter = 'queueFull' | 'busy' | 'timeouts' | 'errors' | 'passThroughErrors';

/** Counters kept by a log store, since it opened. */
export interface LogCounters {
  readonly logWriteFailures: number;
  readonly logDropped: number;
}

/** Counters kept by an engine supervisor, since it was created. */
export interface EngineCounters {
  readonly engineRestarts: number;
  readonly engineHangs: number;
}

/** Everything `/health` reports under `counters`: monotonic integers since gateway start. */
export type HealthCounters = Readonly<Record<DecisionCounter, number>> &
  LogCounters &
  EngineCounters;

export const NO_ENGINE_COUNTERS: EngineCounters = { engineRestarts: 0, engineHangs: 0 };

export function addEngineCounters(a: EngineCounters, b: EngineCounters): EngineCounters {
  return {
    engineRestarts: a.engineRestarts + b.engineRestarts,
    engineHangs: a.engineHangs + b.engineHangs,
  };
}

/** Monotonically increasing decision counters. Never reset. */
export class DecisionCounters {
  readonly #values: Record<DecisionCounter, number> = {
    queueFull: 0,
    busy: 0,
    timeouts: 0,
    errors: 0,
    passThroughErrors: 0,
  };

  inc(name: DecisionCounter): void {
    this.#values[name] += 1;
  }

  snapshot(): Readonly<Record<DecisionCounter, number>> {
    return { ...this.#values };
  }
}
