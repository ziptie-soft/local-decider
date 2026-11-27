import type { ModelSource } from '@ziptie-soft/local-decider-core';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PolicySelection } from './config.ts';
import { NO_ENGINE_COUNTERS, type EngineCounters } from './counters.ts';
import type { ManagedEngine } from './engines/lazy.ts';
import type { Engine, EngineState } from './engines/types.ts';
import { LatencyWindow, SerialQueue } from './queue.ts';

/** Lane key of the engine every decision uses unless a policy routes elsewhere. */
export const PRIMARY_LANE = 'primary';

/** Recent engine jobs timed for the busy estimate. */
const SERVICE_WINDOW = 50;

/** How often a retiring lane is checked for idleness. */
const IDLE_POLL_MS = 10;

/**
 * A lane's engine. Policy lanes hold a {@link ManagedEngine}; the primary may be a bare `Engine`
 * (tests), which then has nothing to drain or retire.
 */
export type LaneEngine = Engine & Partial<Pick<ManagedEngine, 'drain' | 'retire'>>;

/** One engine with its own queue, service-time window and generation. */
export interface EngineLane {
  readonly key: string;
  readonly engine: LaneEngine;
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

/** Where a policy's decisions go, set by the lane planner. */
export interface PolicyRoute {
  /** The lane that answers; null when no model does. */
  readonly laneKey: string | null;
  /** What a decision served by this route reports as `modelSource`. */
  readonly source: ModelSource;
  readonly fallback: PolicySelection['fallback'];
  /** The override the user asked for: what an `unavailable` decision names as its engine and model. */
  readonly configured: Pick<PolicySelection, 'engine' | 'model'>;
  /** Why the override is not answering, for `unavailable` and `fallback` routes. */
  readonly reason?: string;
}

/** One lane's state for status. */
export interface LaneStat {
  readonly key: string;
  readonly state: EngineState;
  /** Decisions waiting for or holding the lane's engine. */
  readonly queueDepth: number;
  /** Median engine call time; undefined until one was timed. */
  readonly p50Ms: number | undefined;
  readonly counters: EngineCounters;
}

/** The key of the lane serving `model` on `engine`, with the resolved `device` when it has one. */
export function laneKey(engine: string, model: string, device?: string): string {
  return device === undefined ? `${engine}:${model}` : `${engine}:${model}@${device}`;
}

/** A lane with an empty queue, window and counters. */
export function createLane(key: string, engine: LaneEngine, queueGraceMs: number): EngineLane {
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

/** Decisions waiting for the lane's engine to load, in its queue or running. */
export function laneDepth(lane: EngineLane): number {
  return lane.queue.depth + lane.preparing;
}

/** The lane's state for status. */
export function laneStat(lane: EngineLane): LaneStat {
  return {
    key: lane.key,
    state: lane.engine.health().state,
    queueDepth: laneDepth(lane),
    p50Ms: lane.service.percentile(50),
    counters: lane.engine.counters?.() ?? NO_ENGINE_COUNTERS,
  };
}

/** Resolve once nothing waits for or runs on the lane, or after `timeoutMs`. */
export async function waitForIdle(lane: EngineLane, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (laneDepth(lane) > 0 && performance.now() < deadline) {
    await sleep(IDLE_POLL_MS);
  }
}
