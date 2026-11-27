import type { GatewayConfig, PolicySelection } from './config.ts';
import type { Decider } from './decider.ts';
import { PRIMARY_LANE, type PolicyRoute } from './engine-lane.ts';
import type { LifecycleOptions, ManagedEngine } from './engines/lazy.ts';
import type { LanePlan, LanePlanInput, LaneStart } from './policy-engines.ts';

/** Why a lane that is going away fails open for the decisions it still holds. */
const LANE_RETIRE_REASON = 'engine switching';

/**
 * The policies that still exist and have an engine and model of their own. A selection left in
 * config.yaml for a policy that is gone is ignored: it would take a lane and memory for nothing.
 */
export function laneSelections(
  policies: GatewayConfig['policies'],
  exists: (id: string) => boolean,
): Map<string, PolicySelection> {
  return new Map(
    Object.entries(policies).flatMap(([id, settings]) =>
      settings.selection === undefined || !exists(id) ? [] : [[id, settings.selection] as const],
    ),
  );
}

/**
 * The routes while a benchmark owns the machine: every override answers as its `fallback` says,
 * never as a lane. Decisions are held for the lease anyway; this keeps the routes truthful, and
 * never empty, for anything that reads them meanwhile.
 * Computed once, at suspend time; the plan at the end of the lease refreshes them.
 */
export function suspendedRoutes(
  selections: ReadonlyMap<string, PolicySelection>,
  reason: string,
): Map<string, PolicyRoute> {
  return new Map(
    [...selections].map(([id, selection]) => [
      id,
      {
        laneKey: selection.fallback === 'default' ? PRIMARY_LANE : null,
        source: selection.fallback === 'default' ? 'fallback' : 'unavailable',
        fallback: selection.fallback,
        configured: { engine: selection.engine, model: selection.model },
        reason,
      },
    ]),
  );
}

/** The policies whose own model is `model` on `engine`, in id order. */
export function policiesUsing(
  selections: ReadonlyMap<string, PolicySelection>,
  engine: string,
  model: string,
): string[] {
  return [...selections]
    .filter(([, selection]) => selection.engine === engine && selection.model === model)
    .map(([id]) => id)
    .toSorted();
}

/**
 * The plan when the planner itself failed during a change of the default model: no lane can be
 * kept, and each override that is not off answers as its `fallback` says. Never empty routes: a
 * policy without a route answers as `default`, which an override with `fallback: open` must not.
 */
export function degradedPlan(input: LanePlanInput, reason: string): LanePlan {
  const routes = new Map<string, PolicyRoute>();
  const status = new Map<string, { status: 'unavailable' | 'off'; reason?: string }>();
  for (const [id, selection] of input.selections) {
    if (input.modes.get(id) === 'off') {
      status.set(id, { status: 'off' });
      continue;
    }
    status.set(id, { status: 'unavailable', reason });
    routes.set(id, {
      laneKey: selection.fallback === 'default' ? PRIMARY_LANE : null,
      source: selection.fallback === 'default' ? 'fallback' : 'unavailable',
      fallback: selection.fallback,
      configured: { engine: selection.engine, model: selection.model },
      reason,
    });
  }
  return { keep: [], start: [], retire: [...input.loaded], routes, status };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The engines of the policy lanes that run now. EngineControl owns them: it builds and starts each
 * one, and retires it through the decider before forgetting it. The primary is not kept here.
 */
export class PolicyLanes {
  readonly #engines = new Map<string, ManagedEngine>();

  /** Every lane that exists, healthy or not. */
  keys(): string[] {
    return this.#keys(() => true);
  }

  /** The lanes the planner may keep; a failed lane is left out so it is rebuilt. */
  healthyKeys(): Set<string> {
    return new Set(this.#keys((engine) => engine.health().state !== 'failed'));
  }

  /** The lanes whose engine gave up (`failed`), to be retired and, when still wanted, rebuilt. */
  failedKeys(): string[] {
    return this.#keys((engine) => engine.health().state === 'failed');
  }

  #keys(test: (engine: ManagedEngine) => boolean): string[] {
    return [...this.#engines].filter(([, engine]) => test(engine)).map(([key]) => key);
  }

  /**
   * Retire each lane through the decider (its decisions fail open, then its engine is drained and
   * stopped for good) and forget it. Every lane is tried; a failure to stop one is only reported.
   */
  async retire(decider: Decider, keys: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(
      keys.map((key) => decider.retireLane(key, LANE_RETIRE_REASON)),
    );
    for (const [at, key] of keys.entries()) {
      const engine = this.#engines.get(key);
      this.#engines.delete(key);
      const result = results[at];
      if (result?.status === 'rejected') {
        console.warn(
          `local-decider: retiring policy lane ${key} failed: ${messageOf(result.reason)}`,
        );
        // The lane is forgotten either way: its engine must not be left running unowned.
        void engine?.stop().catch(() => undefined);
      }
    }
  }

  /** Builds and installs each lane; one that cannot be built is reported and has no lane. */
  install(
    decider: Decider,
    starts: readonly LaneStart[],
    build: (selection: PolicySelection) => ManagedEngine,
  ): ManagedEngine[] {
    const installed: ManagedEngine[] = [];
    for (const { key, selection } of starts) {
      try {
        const engine = build(selection);
        decider.installLane(key, engine);
        this.#engines.set(key, engine);
        installed.push(engine);
      } catch (error) {
        console.warn(`local-decider: policy lane ${key} not installed: ${messageOf(error)}`);
      }
    }
    return installed;
  }

  /** Eager lanes load now and lazy ones on their first decision; a lane retired meanwhile is skipped. */
  start(engines: readonly ManagedEngine[]): void {
    for (const engine of engines) {
      void engine.start().catch(() => undefined);
    }
  }

  setLifecycle(options: LifecycleOptions): void {
    for (const engine of this.#engines.values()) {
      engine.setLifecycle(options);
    }
  }

  /** Unload every lane; all are tried, and the first failure is thrown. */
  async unload(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#engines.values()].map((engine) => engine.unload()),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) {
      throw failed.reason;
    }
  }
}
