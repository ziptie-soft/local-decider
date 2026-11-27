/**
 * The Model row of a decision card, as pure functions: what it shows for a catalog and what a
 * change posts. The card's component only wires these to the select and the shared action.
 */
import type { GatewayPolicy, PluginMode } from './constants.ts';
import {
  fallbackOf,
  headerBadge,
  modelOptions,
  modelOutcome,
  modelRowHint,
  ownSelection,
  routingVariantHint,
  selectionValue,
  type ModelBadge,
  type ModelHintContext,
  type ModelOption,
  type ModelOutcome,
  type ModelWriteResult,
} from './decision-models.ts';
import type { EngineCatalog } from './engines.ts';
import type { PolicySelectionInput, StatusLine } from './policies.ts';
import type { PolicyModel } from './policy-models.ts';

type Fallback = NonNullable<PolicyModel['fallback']>;

/** The longest a card keeps showing its choice while it waits for the gateway's state. */
export const HOLD_MAX_MS = 10_000;

export interface HoldInputs {
  readonly policy: GatewayPolicy;
  /** The card that started the write now held, or the last one. */
  readonly owner: GatewayPolicy | null;
  /** A write runs, or its refetch has not landed yet. */
  readonly holding: boolean;
  /** The policy whose action runs, or null. */
  readonly busy: GatewayPolicy | null;
}

/**
 * What a card does while the section writes: `mine` shows its own choice instead of the gateway's
 * (the write runs or its refetch is pending), `blocked` disables its selects (any card writes).
 */
export function holdState(i: HoldInputs): { mine: boolean; blocked: boolean } {
  return {
    mine: (i.holding && i.owner === i.policy) || i.busy === i.policy,
    blocked: i.holding || i.busy !== null,
  };
}

/** What a decision card knows about its Model row besides the catalog. */
export interface ModelRowInputs {
  readonly kind: GatewayPolicy;
  /** Undefined while the engines query is pending. */
  readonly catalog: EngineCatalog | undefined;
  readonly reachable: boolean;
  readonly mode: PluginMode;
  /** The gateway's modes were fetched successfully. */
  readonly modesLoaded: boolean;
  /** The gateway's mode of this decision; undefined when it has not loaded the policy. */
  readonly gatewayMode: PluginMode | undefined;
  /** The model a write from this card is switching to, while it runs. */
  readonly writing: ModelOption | null;
}

export interface ModelSelectView {
  readonly options: readonly ModelOption[];
  /** The select's value: the model that answers now, or the one being switched to. */
  readonly value: string;
  /** The line under the row; null when there is nothing to say. */
  readonly line: StatusLine | null;
  /** The select cannot change now (the card also disables it while any write runs). */
  readonly disabled: boolean;
  /** The older gateway cannot choose per decision: show a static row, not a select. */
  readonly unsupported: boolean;
  readonly badge: ModelBadge | null;
  /** What the decision does when its model is unavailable; posted again on a change. */
  readonly fallback: Fallback;
}

const DEFAULT_ONLY: readonly ModelOption[] = [
  {
    label: 'Default',
    detail: 'No default model yet',
    value: 'default',
    selection: undefined,
    modelLabel: null,
  },
];

function hintContext(i: ModelRowInputs): ModelHintContext {
  return {
    catalog: i.catalog,
    reachable: i.reachable,
    mode: i.mode,
    // Loaded unless the gateway answered its modes and left this decision out: its selection
    // route refuses an unknown policy, for hook kinds as well as command risk.
    policyLoaded: !(i.modesLoaded && i.gatewayMode === undefined),
    writing: i.writing === null ? null : { label: i.writing.modelLabel },
  };
}

/** The line: the Routing card's variant text when it applies, else the table row. */
function lineOf(
  i: ModelRowInputs,
  ctx: ModelHintContext,
): { line: StatusLine | null; disabled: boolean } {
  const row = modelRowHint(i.kind, ctx);
  const variant = i.kind === 'routing' ? routingVariantHint(ctx) : null;
  return variant === null ? row : { ...row, line: { text: variant, tone: 'muted' } };
}

/** What a decision's Model row shows for the catalog and the state of its card. */
export function modelSelectView(i: ModelRowInputs): ModelSelectView {
  const ctx = hintContext(i);
  const entry = i.catalog?.policies?.find((p) => p.id === i.kind);
  const own = ownSelection(entry);
  const { line, disabled } = lineOf(i, ctx);
  return {
    options: i.catalog === undefined ? DEFAULT_ONLY : modelOptions(i.kind, i.catalog, own),
    value: i.writing === null ? selectionValue(own) : i.writing.value,
    line,
    disabled,
    unsupported: i.catalog !== undefined && i.catalog.policies === undefined,
    badge: headerBadge(i.kind, ctx),
    fallback: fallbackOf(entry),
  };
}

/**
 * The body of `policySelectionRpc` for a chosen option: Default model clears; a model carries the
 * decision's current fallback (the gateway resets it to `default` otherwise) and a `device` only
 * when it is not `auto`.
 */
export function selectionInput(
  kind: GatewayPolicy,
  option: ModelOption,
  fallback: Fallback,
): PolicySelectionInput {
  const { selection } = option;
  if (selection === undefined) {
    return { policy: kind, selection: { clear: true } };
  }
  const { device } = selection;
  return {
    policy: kind,
    selection: {
      engine: selection.engine,
      model: selection.model,
      ...(device === undefined || device === 'auto' ? {} : { device }),
      fallback,
    },
  };
}

/** The option whose select value was chosen; undefined when the list lacks it. */
export function optionByValue(
  options: readonly ModelOption[],
  value: string,
): ModelOption | undefined {
  return options.find((o) => o.value === value);
}

/**
 * Posts the choice and words the result for the card: a rejected call is "unreachable", never
 * thrown, so the card always gets an outcome to announce.
 */
export async function writeModel(
  post: (input: PolicySelectionInput) => Promise<ModelWriteResult>,
  kind: GatewayPolicy,
  option: ModelOption,
  mode: PluginMode,
  fallback: Fallback,
): Promise<ModelOutcome> {
  let res: ModelWriteResult;
  try {
    res = await post(selectionInput(kind, option, fallback));
  } catch {
    res = { ok: false, unreachable: true };
  }
  return modelOutcome(kind, option.modelLabel, mode, res, fallback);
}
