import { ENGINE_BUSY_ERROR } from './engines/types.ts';

export const ENGINE_BENCHMARK_RUNNING_ERROR = 'engine benchmark running';

export class EngineBusyError extends Error {
  override readonly name = 'EngineBusyError';
}

/**
 * Records the engine never judged, skipped by calibration, agreement and labelled counts: a
 * benchmark held the engine, or it was busy (its 503 or `budgetMs` admission).
 */
export function isUnjudged(error: string | undefined): boolean {
  return error === ENGINE_BENCHMARK_RUNNING_ERROR || error === ENGINE_BUSY_ERROR;
}
