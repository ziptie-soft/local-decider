import type { Engine } from './engines/types.ts';
import { LatencyWindow, SerialQueue } from './queue.ts';

/** Lane key of the engine every decision uses unless a policy routes elsewhere. */
export const PRIMARY_LANE = 'primary';

/** Recent engine jobs timed for the busy estimate. */
const SERVICE_WINDOW = 50;

/** One engine with its own queue, service-time window and generation. */
export interface EngineLane {
  readonly key: string;
  readonly engine: Engine;
  /** Bumped when the lane is retired: work admitted before it must not run. */
  generation: number;
  readonly queue: SerialQueue;
  /** Time inside the engine call only (no queue wait), for `budgetMs` admission. */
  readonly service: LatencyWindow;
  /** Decisions between admission and the queue, waiting for the engine to load. */
  preparing: number;
  /** Why decisions on this lane fail open now, or null. */
  blocked: string | null;
  retired: boolean;
}

/** The key of the lane serving `model` on `engine`, with the resolved `device` when it has one. */
// fallow-ignore-next-line unused-export -- the lane planner and policy routes take it (P2.4+).
export function laneKey(engine: string, model: string, device?: string): string {
  return device === undefined ? `${engine}:${model}` : `${engine}:${model}@${device}`;
}

/** A lane with an empty queue, window and counters. */
export function createLane(key: string, engine: Engine, queueGraceMs: number): EngineLane {
  return {
    key,
    engine,
    generation: 0,
    queue: new SerialQueue({
      abandonGraceMs: queueGraceMs,
      ...(engine.concurrency === undefined ? {} : { concurrency: engine.concurrency }),
    }),
    service: new LatencyWindow(SERVICE_WINDOW),
    preparing: 0,
    blocked: null,
    retired: false,
  };
}
