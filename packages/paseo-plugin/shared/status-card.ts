/**
 * The Status card of the settings page as pure functions: the gateway row and the default model
 * row with its one Load now / Unload button. The components only wire these to the rows.
 */
import { defaultModelName, hasOwnModels } from './decision-models.ts';
import { engineTag, type EngineCatalog } from './engines.ts';
import { engineStateSentence } from './lifecycle.ts';
import { formatMs } from './stats.ts';
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
  // The live p50, unrounded like the quick-status popover and the sidebar, so the three agree.
  const typical =
    status.p50Ms === null ? '' : ` · recent decisions: typically ${formatMs(status.p50Ms)}`;
  return { label: 'Gateway is running', hint: `Answering at ${status.gatewayUrl}${typical}` };
}

export interface DefaultModelRowInput {
  /** The gateway's status check; undefined before the first answer. */
  readonly status: StatusLike | undefined;
  /** The engines catalog; undefined while it loads or when the request failed. */
  readonly catalog: EngineCatalog | undefined;
  /** The engines request failed: do not keep saying `Checking…`. */
  readonly catalogFailed: boolean;
  /** The action running now (`load`, `unload`, `lifecycle`), or null. */
  readonly busy: string | null;
}

export interface DefaultModelRow {
  readonly hint: string;
  /** The row's error text: a model that failed to load. */
  readonly error: string | null;
  readonly actionLabel: string;
  /** What the button does: load the model, or unload (which also cancels a load). */
  readonly action: 'load' | 'unload';
  readonly disabled: boolean;
}

const UNLOAD_ALL_HINT =
  "Unload all also unloads the decisions' own models; each loads again on its next decision.";

const NO_MODEL_HINT = 'None yet. Choose one under Models; until then every decision is skipped.';

/** What the row says when the gateway is up but gave no model list. */
const MODELS_UNKNOWN_HINT = 'Unknown: the gateway did not list its models.';

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

/** `Failed to load: {detail}`; the gateway's detail, without its closing full stop. */
function failureText(status: StatusLike, catalog: EngineCatalog): string {
  const detail = status.detail ?? catalog.active?.detail ?? 'no detail from the gateway';
  return `Failed to load: ${detail.endsWith('.') ? detail.slice(0, -1) : detail}`;
}

/** The state the buttons act on; a stale catalog must not offer Unload while the gateway is down. */
function liveState(
  status: StatusLike | undefined,
  catalog: EngineCatalog | undefined,
): string | null {
  return status?.up === true ? (status.engineState ?? catalog?.active?.state ?? null) : null;
}

function missingHint(
  status: StatusLike | undefined,
  catalog: EngineCatalog | undefined,
  failed: boolean,
): string | null {
  if (status === undefined || (status.up && catalog === undefined && !failed)) {
    return 'Checking…';
  }
  if (!status.up) {
    return 'Unknown while the gateway is not running.';
  }
  return catalog === undefined || !catalog.reachable ? MODELS_UNKNOWN_HINT : null;
}

/** The hint and the error text of the row: a failed model keeps its name and moves why to `error`. */
function textOf(i: DefaultModelRowInput): { hint: string; error: string | null } {
  const { status, catalog } = i;
  const missing = missingHint(status, catalog, i.catalogFailed);
  if (missing !== null || status === undefined || catalog === undefined) {
    return { hint: missing ?? 'Checking…', error: null };
  }
  const name = defaultModelName(catalog);
  if (name === null) {
    return { hint: NO_MODEL_HINT, error: null };
  }
  if (liveState(status, catalog) === 'failed') {
    return { hint: name, error: failureText(status, catalog) };
  }
  return { hint: `${name}. ${stateSentence(status, catalog)}`, error: null };
}

/** The button: Unload when loaded, Cancel loading while it starts, Load now otherwise (retry too). */
function buttonOf(
  state: string | null,
  busy: string | null,
  all: boolean,
): Pick<DefaultModelRow, 'action' | 'actionLabel'> {
  if (state === 'ready' || state === 'starting') {
    const unload = all ? 'Unload all' : 'Unload';
    const label = state === 'ready' ? unload : 'Cancel loading';
    return { action: 'unload', actionLabel: busy === 'unload' ? 'Unloading…' : label };
  }
  return { action: 'load', actionLabel: busy === 'load' ? 'Loading…' : 'Load now' };
}

/** The Default model row: its model, its state, and the button that loads or unloads it. */
export function defaultModelRow(i: DefaultModelRowInput): DefaultModelRow {
  const { status, catalog, busy } = i;
  const chosen = catalog?.active?.engine != null && catalog.active.model != null;
  const state = liveState(status, catalog);
  const all = hasOwnModels(catalog);
  const button = buttonOf(state, busy, all);
  const blocked = status?.up !== true || busy !== null || !chosen;
  const text = textOf(i);
  const unloads = state === 'ready' && all && text.error === null;
  return {
    hint: unloads ? `${text.hint} ${UNLOAD_ALL_HINT}` : text.hint,
    error: text.error,
    action: button.action,
    actionLabel: button.actionLabel,
    disabled: blocked,
  };
}
