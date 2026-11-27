/**
 * The Status card of the settings page as pure functions: the gateway row and the default model
 * row with its one Load now / Unload button. The components only wire these to the rows.
 */
import { defaultModelName } from './decision-models.ts';
import { engineTag, type EngineCatalog } from './engines.ts';
import { engineStateSentence } from './lifecycle.ts';
import { compactMs } from './poll.ts';
import type { Status } from './status.ts';

type StatusLike = Pick<
  Status,
  'up' | 'gatewayUrl' | 'p50Ms' | 'engineState' | 'detail' | 'benchmark' | 'engine' | 'engineTag'
>;

/** `Gateway is running` and where it answers; `Checking…` before the first answer. */
export function gatewayRow(status: StatusLike | undefined): { label: string; hint: string } {
  if (status === undefined) {
    return { label: 'Gateway', hint: 'Checking…' };
  }
  if (!status.up) {
    return {
      label: 'Gateway is not running',
      hint: `No answer from ${status.gatewayUrl}. Start it with: local-decider gateway start (on the computer that runs the Paseo daemon).`,
    };
  }
  const typical = status.p50Ms === null ? '' : ` · typical decision ${compactMs(status.p50Ms)}`;
  return { label: 'Gateway is running', hint: `Answering at ${status.gatewayUrl}${typical}` };
}

export interface DefaultModelRowInput {
  /** The gateway's status check; undefined before the first answer. */
  readonly status: StatusLike | undefined;
  /** The engines catalog; undefined while it loads. */
  readonly catalog: EngineCatalog | undefined;
  /** The action running now (`load`, `unload`, `lifecycle`), or null. */
  readonly busy: string | null;
}

export interface DefaultModelRow {
  readonly hint: string;
  readonly actionLabel: string;
  /** What the button does: load the model, or unload it. */
  readonly action: 'load' | 'unload';
  readonly disabled: boolean;
}

const NO_MODEL_HINT = 'None yet. Choose one under Models; until then every decision is skipped.';

/** The state the sentence describes: health is the live source, the catalog adds the lifecycle. */
function stateSentence(status: StatusLike, catalog: EngineCatalog): string {
  const active = catalog.active;
  return engineStateSentence({
    state: status.engineState ?? active?.state ?? null,
    detail: status.detail ?? active?.detail ?? null,
    model: null,
    engineTag: engineTag(status.engine, status.engineTag),
    lifecycle: active?.lifecycle ?? null,
    benchmark: status.benchmark ?? active?.benchmark ?? null,
  });
}

function hintOf(status: StatusLike | undefined, catalog: EngineCatalog | undefined): string {
  if (status === undefined || (status.up && catalog === undefined)) {
    return 'Checking…';
  }
  if (!status.up) {
    return 'Unknown while the gateway is not running.';
  }
  if (catalog === undefined || !catalog.reachable) {
    return 'Unknown: the gateway did not list its engines.';
  }
  const name = defaultModelName(catalog);
  return name === null ? NO_MODEL_HINT : `${name}. ${stateSentence(status, catalog)}`;
}

/** The state the buttons act on; a stale catalog must not offer Unload while the gateway is down. */
function liveState(
  status: StatusLike | undefined,
  catalog: EngineCatalog | undefined,
): string | null {
  return status?.up === true ? (status.engineState ?? catalog?.active?.state ?? null) : null;
}

/** The Default model row: its model, its state, and the button that loads or unloads it. */
export function defaultModelRow(i: DefaultModelRowInput): DefaultModelRow {
  const { status, catalog, busy } = i;
  const chosen = catalog?.active?.engine != null && catalog.active.model != null;
  const hint = hintOf(status, catalog);
  const blocked = status?.up !== true || busy !== null || !chosen;
  if (liveState(status, catalog) === 'ready') {
    const label = busy === 'unload' ? 'Unloading…' : 'Unload';
    return { hint, action: 'unload', actionLabel: label, disabled: blocked };
  }
  const loading = busy === 'load' || liveState(status, catalog) === 'starting';
  const label = loading ? 'Loading…' : 'Load now';
  return { hint, action: 'load', actionLabel: label, disabled: blocked || loading };
}
