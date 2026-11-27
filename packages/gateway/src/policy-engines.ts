import type { Mode } from '@ziptie-soft/local-decider-core';

import type { PolicySelection } from './config.ts';
import { laneKey, PRIMARY_LANE, type PolicyRoute } from './engine-lane.ts';

/** Policies that may have their own model at once, besides the default one. */
export const MAX_POLICY_LANES = 3;

/** An engine and model, as the planner sees one: the default model or a policy's own. */
export interface PlanSelection {
  readonly engine: string;
  readonly model: string;
  readonly device?: string | null | undefined;
}

/**
 * What the planner works from. The caller must pass only policies that still exist in
 * `selections`: a stale selection would take a lane and memory it has no use for.
 */
export interface LanePlanInput {
  /** The default model: it always keeps its place, and an override that no longer fits loses. */
  readonly primary: PlanSelection;
  /** Each policy's own model, by policy id; only policies that still exist. */
  readonly selections: ReadonlyMap<string, PolicySelection>;
  /**
   * A policy to place after all others, whatever its id, so a cap, memory or fastflowlm refusal
   * lands on it (the candidate of a set) and not on a policy that already has its lane.
   */
  readonly last?: string;
  /** The effective mode of each policy; a policy missing here is not off. */
  readonly modes: ReadonlyMap<string, Mode>;
  /** The keys of the policy lanes running now (the primary is never listed). */
  readonly loaded: ReadonlySet<string>;
}

/** What the planner asks of the machine; injected so the plan itself does no I/O. */
export interface LanePlanDeps {
  /** Rejects an override that cannot run: unknown, not installed, engine unavailable... */
  readonly check: (selection: PolicySelection) => void | Promise<void>;
  /** Memory the model needs on its resolved device, or null when unknown (counted as 0). */
  readonly memoryGb: (selection: PlanSelection) => number | null;
  /** Whether the model takes this machine's memory; a remote or attached server does not. */
  readonly isLocal: (selection: PlanSelection) => boolean;
  /** The device the model runs on, which is part of its lane key. */
  readonly resolveDevice: (selection: PlanSelection) => string | undefined;
  /** What every local model together may take, in GB. */
  readonly budgetGb: number;
}

/** A lane to build and install. */
export interface LaneStart {
  readonly key: string;
  readonly selection: PolicySelection;
}

export interface PolicySelectionStatus {
  /** `off`: the policy is off, so its model is not loaded; the memory stays reserved. */
  readonly status: 'active' | 'unavailable' | 'off';
  /** Why the override is not answering. */
  readonly reason?: string;
}

export interface LanePlan {
  /** Running lanes that stay. */
  readonly keep: readonly string[];
  /** Lanes to build, then install. */
  readonly start: readonly LaneStart[];
  /** Running lanes no policy wants any more. */
  readonly retire: readonly string[];
  /** The route of each policy with an override that is not off. */
  readonly routes: ReadonlyMap<string, PolicyRoute>;
  readonly status: ReadonlyMap<string, PolicySelectionStatus>;
}

const sortById = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The model that takes the machine's only FastFlowLM server, and who asked for it. */
interface FlmUse {
  readonly model: string;
  readonly owner: string;
}

class LanePlanner {
  readonly #input: LanePlanInput;
  readonly #deps: LanePlanDeps;
  readonly #primaryKey: string;
  readonly #lanes = new Map<string, LaneStart>();
  readonly #routes = new Map<string, PolicyRoute>();
  readonly #status = new Map<string, PolicySelectionStatus>();
  /** Lane keys that already have their memory reserved, off ones included. */
  readonly #paid = new Set<string>();
  #usedGb = 0;
  #flm: FlmUse | undefined;

  constructor(input: LanePlanInput, deps: LanePlanDeps) {
    this.#input = input;
    this.#deps = deps;
    this.#primaryKey = this.#keyOf(input.primary);
    this.#paid.add(this.#primaryKey);
    if (deps.isLocal(input.primary)) {
      this.#usedGb = deps.memoryGb(input.primary) ?? 0;
    }
    if (input.primary.engine === 'fastflowlm') {
      this.#flm = { model: input.primary.model, owner: 'the default model' };
    }
  }

  async plan(): Promise<LanePlan> {
    for (const id of this.#order()) {
      const selection = this.#input.selections.get(id);
      if (selection === undefined) continue;
      if (this.#input.modes.get(id) === 'off') {
        this.#off(id, selection);
      } else {
        await this.#place(id, selection);
      }
    }
    return this.#result();
  }

  /** Policy ids in id order, with `last` moved to the end. */
  #order(): string[] {
    const { last, selections } = this.#input;
    const ids = [...selections.keys()].toSorted(sortById);
    return last === undefined || !selections.has(last)
      ? ids
      : [...ids.filter((id) => id !== last), last];
  }

  /** FastFlowLM serves one model on the NPU, so its lane ignores the device. */
  #keyOf(selection: PlanSelection): string {
    const device =
      selection.engine === 'fastflowlm' ? undefined : this.#deps.resolveDevice(selection);
    return laneKey(selection.engine, selection.model, device);
  }

  /** An off policy loads nothing, but keeps its memory so turning it on cannot overflow. */
  #off(id: string, selection: PolicySelection): void {
    this.#status.set(id, { status: 'off' });
    this.#reserve(selection, this.#keyOf(selection));
  }

  async #place(id: string, selection: PolicySelection): Promise<void> {
    const key = this.#keyOf(selection);
    if (key === this.#primaryKey) {
      this.#routes.set(id, route(PRIMARY_LANE, 'default', selection));
      this.#status.set(id, { status: 'active' });
      return;
    }
    const reason = (await this.#rejection(selection)) ?? this.#admit(selection, key, id);
    if (reason === undefined) {
      this.#routes.set(id, route(key, 'policy', selection));
      this.#status.set(id, { status: 'active' });
    } else {
      this.#fail(id, selection, reason);
    }
  }

  /** The reason `check` gives, or undefined; a bad override never throws out of the plan. */
  async #rejection(selection: PolicySelection): Promise<string | undefined> {
    try {
      await this.#deps.check(selection);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Adds the lane when the caps and the memory budget allow; otherwise says why not. */
  #admit(selection: PolicySelection, key: string, id: string): string | undefined {
    if (this.#lanes.has(key)) {
      return undefined;
    }
    const refusal =
      this.#capRefusal() ?? this.#flmRefusal(selection) ?? this.#reserve(selection, key);
    if (refusal !== undefined) {
      return refusal;
    }
    this.#lanes.set(key, { key, selection });
    if (selection.engine === 'fastflowlm') {
      this.#flm = { model: selection.model, owner: id };
    }
    return undefined;
  }

  #capRefusal(): string | undefined {
    return this.#lanes.size >= MAX_POLICY_LANES
      ? `too many decisions with their own model (max ${String(MAX_POLICY_LANES)})`
      : undefined;
  }

  #flmRefusal(selection: PolicySelection): string | undefined {
    const held = this.#flm;
    return selection.engine === 'fastflowlm' && held !== undefined && held.model !== selection.model
      ? `fastflowlm serves one model at a time; ${held.owner} already uses ${held.model}`
      : undefined;
  }

  /** Takes the model's memory unless it is already paid for or does not fit. */
  #reserve(selection: PolicySelection, key: string): string | undefined {
    if (this.#paid.has(key) || !this.#deps.isLocal(selection)) {
      return undefined;
    }
    const needs = this.#deps.memoryGb(selection) ?? 0;
    if (this.#usedGb + needs > this.#deps.budgetGb) {
      return this.#overflow(needs);
    }
    this.#usedGb += needs;
    this.#paid.add(key);
    return undefined;
  }

  #overflow(needs: number): string {
    const primaryGb = this.#deps.isLocal(this.#input.primary)
      ? (this.#deps.memoryGb(this.#input.primary) ?? 0)
      : 0;
    return primaryGb + needs > this.#deps.budgetGb
      ? 'does not fit with the default model'
      : `needs ~${String(needs)} GB with the other models loaded; this machine allows ~${String(Math.floor(this.#deps.budgetGb))} GB`;
  }

  /** `fallback: default` lets the primary answer; `open` leaves the decision unanswered. */
  #fail(id: string, selection: PolicySelection, reason: string): void {
    this.#status.set(id, { status: 'unavailable', reason });
    this.#routes.set(
      id,
      selection.fallback === 'default'
        ? route(PRIMARY_LANE, 'fallback', selection, reason)
        : route(null, 'unavailable', selection, reason),
    );
  }

  #result(): LanePlan {
    const loaded = [...this.#input.loaded].filter((key) => key !== PRIMARY_LANE);
    const wanted = [...this.#lanes.keys()].toSorted(sortById);
    return {
      keep: wanted.filter((key) => this.#input.loaded.has(key)),
      start: wanted
        .filter((key) => !this.#input.loaded.has(key))
        .flatMap((key) => this.#lanes.get(key) ?? []),
      retire: loaded.filter((key) => !this.#lanes.has(key)).toSorted(sortById),
      routes: this.#routes,
      status: this.#status,
    };
  }
}

function route(
  lane: string | null,
  source: PolicyRoute['source'],
  selection: PolicySelection,
  reason?: string,
): PolicyRoute {
  return {
    laneKey: lane,
    source,
    fallback: selection.fallback,
    configured: { engine: selection.engine, model: selection.model },
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * `PolicyEngines.plan` is async and does no I/O except through the injected `deps`. It decides which policy lanes run, which start and which retire, and where each policy's
 * decisions go. Policies are placed in id order; the default model always keeps its memory, and
 * an override that does not fit, is over a cap or cannot run is `unavailable` (never an error).
 * It reads the machine only through `deps`.
 */
function plan(input: LanePlanInput, deps: LanePlanDeps): Promise<LanePlan> {
  return new LanePlanner(input, deps).plan();
}

export const PolicyEngines = { plan } as const;
