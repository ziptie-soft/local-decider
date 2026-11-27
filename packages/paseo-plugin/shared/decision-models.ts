/**
 * The model of each decision, as the settings and the quick-status popover describe it: the
 * options of a decision's Model select, its hint, badge and outcome, and
 * the popover line. Pure functions over the engines catalog (`GET /v1/engines`, `policies[]`) and
 * `/health` `policyEngines[]`; a decision absent from `policies[]` uses the default model, and
 * `policies` undefined means an older gateway that cannot choose per decision.
 */
import type { GatewayPolicy, PluginMode } from './constants.ts';
import { DECISION_KINDS } from './decision-kinds.ts';
import {
  deviceFor,
  gb,
  measuredDuration,
  measuredSpeed,
  typicalP50,
  type EngineCatalog,
  type EngineModel,
} from './engines.ts';
import { failureReason, type ModeWriteResult, type StatusLine } from './policies.ts';
import type { PolicyEngine, PolicyModel, PolicySelection } from './policy-models.ts';
import { ms, runtimeName } from './recommended-card.ts';

type Fallback = NonNullable<PolicyModel['fallback']>;

/** The Model select's value for "use the default model". */
const DEFAULT_VALUE = 'default';

// ── names ────────────────────────────────────────────────────────────────────────────────────

/** `d3 lite on NPU · 4-bit Q4_K_M`, else `FastFlowLM · d3:lite` when the model is unknown. */
export function runningName(catalog: EngineCatalog): string | null {
  const a = catalog.active;
  if (a?.engine == null) {
    return null;
  }
  const model = catalog.models.find((m) => m.engine === a.engine && m.id === a.model);
  const engine = catalog.engines.find((e) => e.id === a.engine)?.label ?? a.engine;
  if (model?.family == null) {
    return a.model === null ? engine : `${engine} · ${a.model}`;
  }
  const where = runtimeName(catalog, {
    engine: a.engine,
    device: a.resolvedDevice ?? a.device,
    backend: a.backend,
  });
  const format = model.format === null ? '' : ` · ${model.format.label}`;
  return `${model.family.label} on ${where}${format}`;
}

/** A gateway reason as the middle of a sentence: without its closing full stop. */
function sentence(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

// ── speed ────────────────────────────────────────────────────────────────────────────────────

/**
 * How fast a model is on `device`, from a fresh benchmark only: `~{ms} here`, else
 * `speed not measured here`. The catalog's latency hint is a reference, not a measurement.
 */
export function speedHere(model: EngineModel, device: string | null): string {
  return measuredSpeed(model, device) ?? 'speed not measured here';
}

/** Typical p50 above the hooks' budget: 1000 ms is not too slow, 1001 ms is. */
function tooSlow(kind: GatewayPolicy, p50: number | null): boolean {
  return p50 !== null && p50 > DECISION_KINDS[kind].budgets.hooks;
}

// ── the model that answers ───────────────────────────────────────────────────────────────────

/** The decision's own model; undefined for the default model, or when the gateway sent none. */
export function ownSelection(entry: PolicyModel | undefined): PolicySelection | undefined {
  return entry?.status === 'default' ? undefined : entry?.selection;
}

export function fallbackOf(entry: PolicyModel | undefined): Fallback {
  return entry?.fallback ?? entry?.selection?.fallback ?? 'default';
}

interface Target {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
}

type Active = NonNullable<EngineCatalog['active']>;

/** The default model is chosen: the gateway reported both its engine and its model. */
function hasModel(active: EngineCatalog['active']): active is Active & {
  engine: string;
  model: string;
} {
  return active != null && active.engine !== null && active.model !== null;
}

function defaultTarget(catalog: EngineCatalog): Target | null {
  const active = catalog.active;
  if (!hasModel(active)) {
    return null;
  }
  return {
    engine: active.engine,
    model: active.model,
    device: deviceFor(catalog, active.engine, null),
  };
}

/** The engine and model that answer for the decision; null when none does (skipped, no model). */
function targetOf(catalog: EngineCatalog, entry: PolicyModel | undefined): Target | null {
  const own = ownSelection(entry);
  if (own === undefined) {
    return defaultTarget(catalog);
  }
  if (entry?.status === 'unavailable') {
    return fallbackOf(entry) === 'open' ? null : defaultTarget(catalog);
  }
  return {
    engine: own.engine,
    model: own.model,
    device: deviceFor(catalog, own.engine, own.device),
  };
}

function findModel(catalog: EngineCatalog, engine: string, id: string): EngineModel | undefined {
  return catalog.models.find((m) => m.engine === engine && m.id === id);
}

function p50Of(catalog: EngineCatalog, target: Target | null): number | null {
  const model = target === null ? undefined : findModel(catalog, target.engine, target.model);
  return target === null || model === undefined ? null : typicalP50(model, target.device);
}

/**
 * Typical p50 of the model that answers the decision now (its own, or the default model); null
 * when it is not benchmarked, its benchmark is stale, or no model answers.
 */
export function effectiveP50(
  catalog: EngineCatalog,
  entry: PolicyModel | undefined,
): number | null {
  return p50Of(catalog, targetOf(catalog, entry));
}

// ── Model select options ─────────────────────────────────────────────────────────────────────

export interface ModelOption {
  readonly label: string;
  /** The muted second line: runtime and speed, or why the model is not listed. */
  readonly detail: string;
  /** An opaque key for the select; read `selection`, never split it. */
  readonly value: string;
  /** The model this option sets; undefined for Default model, which clears it. */
  readonly selection: PolicySelection | undefined;
  /** The model's name for messages (`modelOutcome`); null for Default model. */
  readonly modelLabel: string | null;
}

/** The select value of a decision's own model; `default` for none. `auto` is an unset device. */
export function selectionValue(selection: PolicySelection | undefined): string {
  return selection === undefined
    ? DEFAULT_VALUE
    : `${selection.engine}|${selection.model}|${selection.device ?? 'auto'}`;
}

/** `{model} · {runtime} · {speed}` of the default model, or `No default model yet`. */
function defaultDetail(catalog: EngineCatalog): string {
  const active = catalog.active;
  if (!hasModel(active)) {
    return 'No default model yet';
  }
  const model = findModel(catalog, active.engine, active.model);
  const where = runtimeName(catalog, {
    engine: active.engine,
    device: active.resolvedDevice ?? active.device,
    backend: active.backend,
  });
  const speed =
    model === undefined
      ? 'speed not measured here'
      : speedHere(model, deviceFor(catalog, active.engine, null));
  return [model?.label ?? active.model, where, speed].join(' · ');
}

function engineAvailable(catalog: EngineCatalog, id: string): boolean {
  return catalog.engines.find((e) => e.id === id)?.available === true;
}

interface Ranked {
  readonly p50: number | null;
  readonly order: number;
}

/** Fastest first, then the unmeasured, each group in catalogue order. */
function bySpeed(a: Ranked, b: Ranked): number {
  if (a.p50 === null || b.p50 === null) {
    return Number(a.p50 === null) - Number(b.p50 === null) || a.order - b.order;
  }
  return a.p50 - b.p50 || a.order - b.order;
}

/**
 * Models that can run here: they fit and their engine is available, and they are installed. A model
 * with no download size (`downloadGb` null) is one an openai-like engine (LM Studio, a remote
 * endpoint) discovered on its own server: there is nothing to download, so it counts as installed.
 */
function selectable(catalog: EngineCatalog): EngineModel[] {
  const usable = catalog.models.filter(
    (m) => m.fits && (m.installed || m.downloadGb === null) && engineAvailable(catalog, m.engine),
  );
  const rows = usable.map((model, order) => ({
    model,
    order,
    p50: typicalP50(model, deviceFor(catalog, model.engine, null)),
  }));
  return rows.toSorted(bySpeed).map((row) => row.model);
}

function optionFor(kind: GatewayPolicy, catalog: EngineCatalog, model: EngineModel): ModelOption {
  const device = deviceFor(catalog, model.engine, null);
  const where = runtimeName(catalog, { engine: model.engine, device, backend: null });
  const parts = [where, speedHere(model, device)];
  if (tooSlow(kind, typicalP50(model, device))) {
    parts.push('too slow for hooks');
  }
  const selection = {
    engine: model.engine,
    model: model.id,
    device: undefined,
    fallback: undefined,
  };
  return {
    label: model.label,
    detail: parts.join(' · '),
    value: selectionValue(selection),
    selection,
    modelLabel: model.label,
  };
}

/** The current override when the list lacks it: `{model} · unavailable`, or `{model} · {device}`. */
function currentOption(
  catalog: EngineCatalog,
  current: PolicySelection | undefined,
  listed: readonly ModelOption[],
): ModelOption[] {
  const value = selectionValue(current);
  if (current === undefined || listed.some((o) => o.value === value)) {
    return [];
  }
  const label = findModel(catalog, current.engine, current.model)?.label ?? current.model;
  const sameModel = listed.some((o) => o.value.startsWith(`${current.engine}|${current.model}|`));
  const suffix = sameModel && current.device !== undefined ? current.device : 'unavailable';
  return [{ label, detail: suffix, value, selection: current, modelLabel: label }];
}

/**
 * The options of a decision's Model select: Default model first, then the models that can run
 * here, fastest first and unmeasured last, then the current override when none of them is it.
 */
export function modelOptions(
  kind: GatewayPolicy,
  catalog: EngineCatalog,
  current: PolicySelection | undefined,
): ModelOption[] {
  const listed = selectable(catalog).map((model) => optionFor(kind, catalog, model));
  return [
    {
      label: 'Default',
      detail: defaultDetail(catalog),
      value: DEFAULT_VALUE,
      selection: undefined,
      modelLabel: null,
    },
    ...listed,
    ...currentOption(catalog, current, listed),
  ];
}

// ── Model row hint and badge ─────────────────────────────────────────────────────────────────

/** What the Model row of a decision card needs to know besides the catalog. */
export interface ModelHintContext {
  /** Undefined while the engines query is pending. */
  readonly catalog: EngineCatalog | undefined;
  /** The gateway answered its last status check. */
  readonly reachable: boolean;
  /** The decision's mode: the Paseo mode of a hook kind, the gateway's for command risk. */
  readonly mode: PluginMode;
  /** False when the gateway has not loaded the policy: the select is disabled with `POLICY_NOT_LOADED_HINT`. */
  readonly policyLoaded: boolean;
  /** A write from this card is in flight: the model it sets, null for the default model. */
  readonly writing: { readonly label: string | null } | null;
}

export interface ModelRowHint {
  /** What shows under the row, or null when there is nothing to say. */
  readonly line: StatusLine | null;
  /** The select cannot change now. */
  readonly disabled: boolean;
}

interface Facts {
  readonly kind: GatewayPolicy;
  readonly mode: PluginMode;
  readonly catalog: EngineCatalog;
  readonly entry: PolicyModel | undefined;
  readonly own: PolicySelection | undefined;
  readonly target: Target | null;
  readonly p50: number | null;
}

type RuleId =
  | 'unavailable-default'
  | 'unavailable-open'
  | 'loading'
  | 'too-slow'
  | 'uncalibrated'
  | 'off'
  | 'same-as-default'
  | 'own-lazy'
  | 'own-eager';

interface Rule {
  readonly id: RuleId;
  /** Problems are warnings; everything else is information. */
  readonly tone: StatusLine['tone'];
  readonly applies: (f: Facts) => boolean;
  readonly text: (f: Facts) => string;
}

function unavailableLead(f: Facts): string {
  return f.entry?.reason === undefined ? 'Unavailable' : `Unavailable: ${sentence(f.entry.reason)}`;
}

/** Where to fix a model that is not downloaded; nothing for any other reason. */
function downloadHint(f: Facts): string {
  return f.entry?.reason?.includes('not downloaded') === true ? ' Download it under Models.' : '';
}

function tooSlowText(f: Facts): string {
  const p50 = f.p50 ?? 0;
  const paseo = DECISION_KINDS[f.kind].budgets.paseo;
  const base = `Too slow for the hooks: typical ${ms(p50)} against a ~1 s limit, so Claude Code, Codex and pi skip most of these decisions.`;
  return paseo !== null && p50 <= paseo
    ? `${base} Paseo waits up to ${ms(paseo)}, so its own requests are answered.`
    : base;
}

function uncalibrated(f: Facts): boolean {
  const engine = f.target?.engine;
  return (
    engine !== undefined && f.catalog.engines.find((e) => e.id === engine)?.calibrated === false
  );
}

function sameAsDefault(f: Facts): boolean {
  const active = f.catalog.active;
  const own = f.own;
  if (own === undefined || active?.engine !== own.engine || active.model !== own.model) {
    return false;
  }
  const device = own.device ?? 'auto';
  if (device === 'auto') {
    // `auto` may pick another device than the one the default model is pinned to.
    return active.device === null || active.device === 'auto';
  }
  return device === (active.resolvedDevice ?? active.device);
}

/** `, about {n} GB of extra memory`, or nothing when the size is unknown. */
function memoryClause(f: Facts): string {
  const memoryGb =
    f.own === undefined
      ? null
      : (findModel(f.catalog, f.own.engine, f.own.model)?.memoryGb ?? null);
  return memoryGb === null ? '' : `, about ${gb(memoryGb)} of extra memory`;
}

/** The problems, which also give the badge next to the decision's title. */
const PROBLEM_RULES: readonly Rule[] = [
  {
    id: 'unavailable-default',
    tone: 'warning',
    applies: (f) => f.entry?.status === 'unavailable' && fallbackOf(f.entry) === 'default',
    text: (f) => `${unavailableLead(f)}. The default model answers instead.${downloadHint(f)}`,
  },
  {
    id: 'unavailable-open',
    tone: 'warning',
    applies: (f) => f.entry?.status === 'unavailable' && fallbackOf(f.entry) === 'open',
    text: (f) => `${unavailableLead(f)}. These decisions are skipped.`,
  },
  {
    id: 'loading',
    tone: 'warning',
    applies: (f) => f.entry?.state === 'starting',
    text: () => 'Loading; decisions are skipped until it is ready.',
  },
  {
    id: 'too-slow',
    tone: 'warning',
    applies: (f) => f.mode !== 'off' && tooSlow(f.kind, f.p50),
    text: tooSlowText,
  },
];

/** `Own model on {runtime}, about {n} GB of extra memory. {lifecycle} {speed}.` */
function ownModelText(f: Facts, lifecycle: string): string {
  const where =
    f.target === null
      ? 'its runtime'
      : runtimeName(f.catalog, { engine: f.target.engine, device: f.target.device, backend: null });
  const model =
    f.target === null ? undefined : findModel(f.catalog, f.target.engine, f.target.model);
  const duration =
    f.target === null || model === undefined ? null : measuredDuration(model, f.target.device);
  const speed =
    duration === null ? 'Speed not measured here.' : `About ${duration} per decision here.`;
  return `Own model on ${where}${memoryClause(f)}. ${lifecycle} ${speed}`;
}

/** The rules after the problems, in order; a decision on the default model matches none. */
const OTHER_RULES: readonly Rule[] = [
  {
    id: 'uncalibrated',
    tone: 'warning',
    applies: (f) => f.mode === 'act' && uncalibrated(f),
    text: () => 'Uncalibrated engine: keep this decision in Shadow until its decisions look right.',
  },
  {
    id: 'off',
    tone: 'muted',
    applies: (f) => f.mode === 'off' && f.own !== undefined,
    text: () => 'Its own model stays unloaded while Mode is Off.',
  },
  {
    id: 'same-as-default',
    tone: 'muted',
    applies: sameAsDefault,
    text: () => 'Same model as the default, but it stays on it if the default changes.',
  },
  {
    id: 'own-lazy',
    tone: 'muted',
    applies: (f) => f.own !== undefined && f.catalog.active?.lifecycle !== 'eager',
    text: (f) => ownModelText(f, 'Loads on its first decision.'),
  },
  {
    id: 'own-eager',
    tone: 'muted',
    applies: (f) => f.own !== undefined,
    text: (f) => ownModelText(f, 'Stays loaded.'),
  },
];

/**
 * Why the select cannot be used: the catalog or the gateway is not there to ask. Nothing is said
 * for a missing gateway or catalog, or an older gateway; the card's other lines cover them.
 */
function blockedRow(ctx: ModelHintContext): ModelRowHint | null {
  if (!ctx.reachable || ctx.catalog?.reachable === false || ctx.catalog === undefined) {
    return { line: null, disabled: true };
  }
  if (ctx.catalog.policies === undefined) {
    return { line: null, disabled: true };
  }
  return ctx.policyLoaded ? null : { line: null, disabled: true };
}

/** The facts the rules read; null when the select cannot be used (see `blockedRow`). */
function factsOf(kind: GatewayPolicy, ctx: ModelHintContext): Facts | null {
  const catalog = ctx.catalog;
  if (catalog === undefined || blockedRow(ctx) !== null) {
    return null;
  }
  const entry = catalog.policies?.find((p) => p.id === kind);
  const target = targetOf(catalog, entry);
  return {
    kind,
    mode: ctx.mode,
    catalog,
    entry,
    own: ownSelection(entry),
    target,
    p50: p50Of(catalog, target),
  };
}

function writingLine(label: string | null): StatusLine {
  const text = label === null ? 'Switching to the default model…' : `Switching to ${label}…`;
  return { text, tone: 'muted' };
}

function firstRule(facts: Facts): Rule | undefined {
  return [...PROBLEM_RULES, ...OTHER_RULES].find((r) => r.applies(facts));
}

/** What shows under a decision's model: the first rule that applies, or nothing. */
export function modelRowHint(kind: GatewayPolicy, ctx: ModelHintContext): ModelRowHint {
  if (ctx.writing !== null) {
    return { line: writingLine(ctx.writing.label), disabled: true };
  }
  const facts = factsOf(kind, ctx);
  if (facts === null) {
    return blockedRow(ctx) ?? { line: null, disabled: false };
  }
  const rule = firstRule(facts);
  return {
    line: rule === undefined ? null : { text: rule.text(facts), tone: rule.tone },
    disabled: false,
  };
}

const OWN_ROWS: readonly RuleId[] = ['own-lazy', 'own-eager'];

/**
 * The line of the Routing card when a routing variant (`routing-budget`, `routing-task-kind`) has
 * its own model in config.yaml, else null. It replaces the default-model and own-model lines only:
 * a problem, Off or a missing gateway still show their own line.
 */
export function routingVariantHint(ctx: ModelHintContext): string | null {
  const facts = ctx.writing === null ? factsOf('routing', ctx) : null;
  const rule = facts === null ? undefined : firstRule(facts);
  if (
    facts === null ||
    facts.mode === 'off' ||
    (rule !== undefined && !OWN_ROWS.includes(rule.id))
  ) {
    return null;
  }
  const variant = facts.catalog.policies?.find(
    (p) => p.id !== 'routing' && p.id.startsWith('routing-') && ownSelection(p) !== undefined,
  );
  const selection = ownSelection(variant);
  if (variant === undefined || selection === undefined) {
    return null;
  }
  const label = variant.label ?? findModel(facts.catalog, selection.engine, selection.model)?.label;
  return `${variant.id} has its own model in config.yaml: ${label ?? selection.model}. This choice applies to the other routing policies.`;
}

export interface ModelBadge {
  readonly tone: 'info' | 'warning';
  readonly text: 'loading' | 'unavailable' | 'too slow';
}

const BADGES: Readonly<Partial<Record<RuleId, ModelBadge>>> = {
  'unavailable-default': { tone: 'warning', text: 'unavailable' },
  'unavailable-open': { tone: 'warning', text: 'unavailable' },
  'loading': { tone: 'info', text: 'loading' },
  'too-slow': { tone: 'warning', text: 'too slow' },
};

/** The badge in a decision card's header: only for a problem, in every mode a row 3-6 shows. */
export function headerBadge(kind: GatewayPolicy, ctx: ModelHintContext): ModelBadge | null {
  const facts = factsOf(kind, ctx);
  const rule = facts === null ? undefined : PROBLEM_RULES.find((r) => r.applies(facts));
  return rule === undefined ? null : (BADGES[rule.id] ?? null);
}

// ── outcome of a write ───────────────────────────────────────────────────────────────────────

/** `ModeWriteResult`, plus the gateway's verdict on the model it accepted. */
export interface ModelWriteResult extends ModeWriteResult {
  readonly status?: PolicyModel['status'] | undefined;
  /** Why the new model is not answering yet (`status` unavailable). */
  readonly reason?: string | undefined;
}

export interface ModelOutcome {
  readonly tone: 'success' | 'warning' | 'error';
  readonly text: string;
}

const UNAVAILABLE_TAIL: Readonly<Record<Fallback, string>> = {
  default: 'The default model answers instead.',
  open: 'These decisions are skipped.',
};

/**
 * The message shown on a card after a model write. `label` is the model that was set, null for
 * the default model; `fallback` is what a model that is not available falls back to.
 */
export function modelOutcome(
  kind: GatewayPolicy,
  label: string | null,
  mode: PluginMode,
  res: ModelWriteResult,
  fallback: Fallback = 'default',
): ModelOutcome {
  const { title } = DECISION_KINDS[kind];
  if (!res.ok) {
    return { tone: 'error', text: `Couldn't switch ${title}: ${failureReason(res)}.` };
  }
  if (label === null) {
    return { tone: 'success', text: `${title} now uses the default model.` };
  }
  if (res.status === 'unavailable') {
    const why = res.reason === undefined ? '' : `: ${sentence(res.reason)}`;
    const text = `${title} now uses ${label}, but it is unavailable${why}. ${UNAVAILABLE_TAIL[fallback]}`;
    return { tone: 'warning', text };
  }
  const tail =
    mode === 'act'
      ? 'Thresholds were tuned for the default model: consider Shadow until its decisions look right.'
      : 'It loads on the first decision.';
  return { tone: 'success', text: `${title} now uses ${label}. ${tail}` };
}

// ── Default model ────────────────────────────────────────────────────────────────────────────

/** Models that could be downloaded and run here but are not downloaded yet. */
export function moreModelsCount(catalog: EngineCatalog): number {
  return catalog.models.filter(
    (m) => !m.installed && m.downloadGb !== null && m.fits && engineAvailable(catalog, m.engine),
  ).length;
}

/** The disclosure that lists every engine and model, with how many are not downloaded yet. */
export function allModelsTitle(catalog: EngineCatalog): string {
  const count = moreModelsCount(catalog);
  return count > 0
    ? `All engines and models · ${String(count)} not downloaded`
    : 'All engines and models';
}

/** The default model as the Status row names it; null when none is chosen. */
export function defaultModelName(catalog: EngineCatalog): string | null {
  return hasModel(catalog.active) ? runningName(catalog) : null;
}

// ── quick-status popover ─────────────────────────────────────────────────────────────────────

type PopoverCase =
  | 'ready'
  | 'loading'
  | 'failed-default'
  | 'failed-open'
  | 'unavailable-default'
  | 'unavailable-open';

function popoverCase(entry: PolicyEngine | undefined): PopoverCase | null {
  if (entry?.status === 'unavailable') {
    return entry.fallback === 'open' ? 'unavailable-open' : 'unavailable-default';
  }
  if (entry?.status !== 'active') {
    return null;
  }
  if (entry.state === 'failed') {
    return entry.fallback === 'open' ? 'failed-open' : 'failed-default';
  }
  // `stopped` is a lazy model that has not loaded yet: it answers on its first decision.
  return entry.state === 'starting' ? 'loading' : 'ready';
}

export interface PopoverModelLine {
  readonly text: string;
  /** `muted` is the popover's muted foreground, `warning` its warning status colour. */
  readonly tone: 'muted' | 'warning';
}

/** The second caption line of a popover row; null for the default model, or an `off` decision. */
export function popoverModelLine(entry: PolicyEngine | undefined): PopoverModelLine | null {
  const name = entry?.label ?? entry?.model;
  switch (popoverCase(entry)) {
    case 'ready':
      return { text: name === undefined ? 'Own model' : `Own model: ${name}`, tone: 'muted' };
    case 'loading':
      return { text: 'Own model loading…', tone: 'muted' };
    case 'failed-default':
      return { text: 'Own model failed · using default', tone: 'warning' };
    case 'failed-open':
      return { text: 'Own model failed · skipped', tone: 'warning' };
    case 'unavailable-default':
      return { text: 'Own model unavailable · using default', tone: 'warning' };
    case 'unavailable-open':
      return { text: 'Own model unavailable · skipped', tone: 'warning' };
    default:
      return null;
  }
}

/** The sentence a popover row's accessibility label appends; null where there is no line. */
export function popoverModelLabel(entry: PolicyEngine | undefined): string | null {
  const name = entry?.label ?? entry?.model;
  switch (popoverCase(entry)) {
    case 'ready':
      return name === undefined ? 'Own model.' : `Own model: ${name}.`;
    case 'loading':
      return 'Own model loading.';
    case 'failed-default':
      return 'Own model failed, using default.';
    case 'failed-open':
      return 'Own model failed, decisions skipped.';
    case 'unavailable-default':
      return 'Own model unavailable, using default.';
    case 'unavailable-open':
      return 'Own model unavailable, decisions skipped.';
    default:
      return null;
  }
}

export interface PopoverModel {
  readonly line: PopoverModelLine | null;
  /** The sentence the row's accessibility label appends. */
  readonly sentence: string | null;
}

/**
 * What a popover row says about its decision's model, from `/health` `policyEngines`. A decision
 * absent from the list uses the default model, and an older gateway sends no list: neither says
 * anything. A lazy own model that has not loaded yet (`stopped`) reads as a ready one: it answers
 * on its first decision. A variant with its own model (for example `routing-budget` or
 * `command-risk-binary`) is not shown on its row: `/health` carries no variant-of or
 * active-variant field to match it to the row.
 */
export function popoverModel(
  engines: readonly PolicyEngine[] | undefined,
  policy: string,
): PopoverModel {
  const entry = engines?.find((e) => e.policy === policy);
  return { line: popoverModelLine(entry), sentence: popoverModelLabel(entry) };
}

/** A popover row's accessibility label with the model sentence appended, when there is one. */
export function popoverRowLabelWith(base: string, model: PopoverModel): string {
  return model.sentence === null ? base : `${base} ${model.sentence}`;
}
