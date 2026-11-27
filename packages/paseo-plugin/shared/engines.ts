/**
 * The gateway's engines and models (`GET /v1/engines`): a lenient parser, the RPC schema it
 * satisfies, and the pure state of each model row on the settings screen.
 */
import { z } from 'zod';

import { connectionSchema, isConnectable, parseConnection } from './connection.ts';
import {
  familySchema,
  formatSchema,
  machineSchema,
  measuredSchema,
  parseFamily,
  parseFormat,
  parseMachine,
  parseMeasuredList,
  parseProgress,
  progressSchema,
} from './machine.ts';
import { bool, fields, items, MAX_TEXT, num, str } from './parse.ts';
import { httpsUrl, parsePaths, pathEntrySchema } from './paths.ts';
import { parsePolicyModels, policyModelSchema, policyModelsStarting } from './policy-models.ts';
import {
  AUTO_ENGINE,
  AUTO_OPTION_LABEL,
  parseFallback,
  parseRecommendation,
  parseSelectionMode,
} from './recommendation.ts';
import { ms } from './recommended-card.ts';

const text = z.string().nullable();

export const validationSchema = z.object({
  ok: z.boolean(),
  checkedAt: text,
  summary: text,
  lines: z.array(z.string()),
});

const engineSchema = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  available: z.boolean(),
  detail: text,
  devices: z.array(z.string()),
  validation: validationSchema.nullable(),
  /** Short name for the sidebar and popover, e.g. `NPU`; the id when the gateway has none. */
  tag: z.string(),
  description: z.string(),
  /** False when the engine's output is not calibrated against the policy thresholds. */
  calibrated: z.boolean(),
  capabilities: z.object({ validate: z.boolean() }),
  supported: z.boolean(),
  unsupportedReason: text,
  /** True when the gateway reports connection settings for this engine (OpenAI-like, new gateways). */
  connectable: z.boolean(),
  connection: connectionSchema.nullable(),
  /** Where to install a missing engine; https only, null when installed or unknown. */
  installUrl: text,
  /** Cached version stamp, e.g. `llama.cpp b12318`; null when unknown or on older gateways. */
  version: text,
});

const modelSchema = z.object({
  id: z.string(),
  engine: z.string(),
  label: z.string(),
  downloadGb: z.number().nullable(),
  memoryGb: z.number().nullable(),
  fits: z.boolean(),
  installed: z.boolean(),
  latencyHint: text,
  recommended: z.boolean(),
  /** The base checkpoint this model belongs to; null on older gateways. */
  family: familySchema.nullable(),
  /** Quantisation, e.g. `Q8_0`; null when not applicable or unknown. */
  format: formatSchema.nullable(),
  /** One benchmark per device; empty when never measured. */
  measured: z.array(measuredSchema),
});

export const downloadSchema = z.object({
  id: z.string(),
  engine: z.string(),
  model: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  startedAt: text,
  finishedAt: text,
  error: text,
  progress: z.number().nullable(),
});

const activeSchema = z.object({
  engine: text,
  model: text,
  device: text,
  /** The device the engine actually runs on when `device` is `auto`. */
  resolvedDevice: text,
  /** `NPU`, `CUDA`, `MLX`, `MPS` or `CPU` when the gateway knows it. */
  backend: text,
  state: text,
  detail: text,
  /** `lazy` loads on the first decision and unloads when idle; `eager` stays loaded. */
  lifecycle: z.enum(['lazy', 'eager']).nullable(),
  idleUnloadMinutes: z.number().nullable(),
  lastUsedAt: text,
  /** `auto`: the gateway ranks engines and falls back on its own. Null on older gateways. */
  selectionMode: z.enum(['auto', 'manual']).nullable(),
  /** Set while the gateway runs a replacement for a failed engine. */
  fallback: z.object({ reason: z.string(), engine: text, device: text, retryAt: text }).nullable(),
  /** The model family automatic selection prefers; null when unset or on older gateways. */
  preferredFamily: text,
  /** Progress of a running benchmark job; null otherwise. */
  benchmark: progressSchema.nullable(),
});

const targetSchema = z.object({
  engine: z.string(),
  model: z.string(),
  device: text,
  reason: z.string(),
});

const recommendationSchema = z.object({
  /** The per-machine view of the model family; null on older gateways. */
  machine: machineSchema.nullable(),
  recommended: targetSchema.extend({ explicit: z.boolean() }).nullable(),
  automatic: targetSchema.extend({ explicit: z.boolean() }).nullable(),
  candidates: z.array(
    targetSchema.extend({
      backend: text,
      code: z
        .enum([
          'available',
          'no-hardware',
          'not-confirmed',
          'unsupported-platform',
          'no-memory',
          'uncalibrated',
        ])
        .nullable(),
      eligible: z.boolean(),
      supported: z.boolean(),
      ready: z.boolean(),
    }),
  ),
});

export const engineCatalogSchema = z.object({
  reachable: z.boolean(),
  active: activeSchema.nullable(),
  totalMemoryGb: z.number().nullable(),
  /** What the gateway would pick on this host, apart from the active selection. */
  recommendation: recommendationSchema.nullable(),
  engines: z.array(engineSchema),
  models: z.array(modelSchema),
  downloads: z.array(downloadSchema),
  paths: z.array(pathEntrySchema),
  /** False for a remote gateway: paths are shown but cannot be changed. */
  pathsEditable: z.boolean(),
  /**
   * The decisions with a model of their own; one absent from the list uses the default model.
   * Undefined from a gateway that predates per-decision models.
   */
  policies: z.array(policyModelSchema).optional().catch(undefined),
});

export type Validation = z.output<typeof validationSchema>;
export type EngineInfo = z.output<typeof engineSchema>;
export type EngineModel = z.output<typeof modelSchema>;
export type Download = z.output<typeof downloadSchema>;
export type ActiveEngine = z.output<typeof activeSchema>;
export type EngineCatalog = z.output<typeof engineCatalogSchema>;

const MAX_ITEMS = 200;
const MAX_LINES = 200;

const list = <T>(value: unknown, parse: (entry: unknown) => T | null): T[] =>
  items(value, MAX_ITEMS, parse);

export function parseValidation(value: unknown): Validation | null {
  const v = fields(value);
  if (v === null || typeof v['ok'] !== 'boolean') {
    return null;
  }
  const lines = Array.isArray(v['lines']) ? v['lines'] : [];
  return {
    ok: v['ok'],
    checkedAt: str(v['checkedAt']),
    summary: str(v['summary']),
    lines: lines
      .slice(0, MAX_LINES)
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.slice(0, MAX_TEXT)),
  };
}

function parseEngine(value: unknown): EngineInfo | null {
  const v = fields(value);
  const id = str(v?.['id']);
  if (v === null || id === null) {
    return null;
  }
  const installed = bool(v['installed'], false);
  const validation = parseValidation(v['validation']);
  const caps = fields(v['capabilities']);
  return {
    id,
    label: str(v['label']) ?? id,
    installed,
    available: bool(v['available'], installed),
    detail: str(v['detail']),
    devices: list(v['devices'], str),
    validation,
    tag: str(v['tag']) ?? id,
    description: str(v['description']) ?? '',
    calibrated: bool(v['calibrated'], true),
    capabilities: { validate: bool(caps?.['validate'], validation !== null) },
    supported: bool(v['supported'], true),
    unsupportedReason: str(v['unsupportedReason']),
    // Only a gateway that sends the `connection` key (null or an object) can save one.
    connectable: isConnectable(id) && 'connection' in v,
    connection: parseConnection(v['connection']),
    installUrl: httpsUrl(v['installUrl']),
    version: str(v['version']),
  };
}

function parseModel(value: unknown): EngineModel | null {
  const v = fields(value);
  const id = str(v?.['id']);
  const engine = str(v?.['engine']);
  if (v === null || id === null || engine === null) {
    return null;
  }
  return {
    id,
    engine,
    label: str(v['label']) ?? id,
    downloadGb: num(v['downloadGb']),
    memoryGb: num(v['memoryGb']),
    // Missing: assume it fits (the gateway refuses with 409 otherwise) but is not downloaded.
    fits: bool(v['fits'], true),
    installed: bool(v['installed'], false),
    latencyHint: str(v['latencyHint']),
    recommended: bool(v['recommended'], false),
    family: parseFamily(v['family']),
    format: parseFormat(v['format']),
    measured: parseMeasuredList(v['measured']),
  };
}

const DOWNLOAD_STATES = new Set(['running', 'done', 'failed']);

export function parseDownload(value: unknown): Download | null {
  const v = fields(value);
  const id = str(v?.['id']);
  const engine = str(v?.['engine']);
  const model = str(v?.['model']);
  const state = v?.['state'];
  if (v === null || id === null || engine === null || model === null) {
    return null;
  }
  if (typeof state !== 'string' || !DOWNLOAD_STATES.has(state)) {
    return null;
  }
  const progress = num(v['progress']);
  return {
    id,
    engine,
    model,
    state: state as Download['state'],
    startedAt: str(v['startedAt']),
    finishedAt: str(v['finishedAt']),
    error: str(v['error']),
    progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
  };
}

function parseActive(value: unknown): ActiveEngine | null {
  const v = fields(value);
  if (v === null) {
    return null;
  }
  return {
    engine: str(v['engine']),
    model: str(v['model']),
    device: str(v['device']),
    resolvedDevice: str(v['resolvedDevice']),
    backend: str(v['backend']),
    state: str(v['state']),
    detail: str(v['detail']),
    lifecycle: v['lifecycle'] === 'lazy' || v['lifecycle'] === 'eager' ? v['lifecycle'] : null,
    idleUnloadMinutes: num(v['idleUnloadMinutes']),
    lastUsedAt: str(v['lastUsedAt']),
    selectionMode: parseSelectionMode(v['selectionMode']),
    fallback: parseFallback(v['fallback']),
    preferredFamily: str(v['preferredFamily']),
    benchmark: parseProgress(v['benchmark']),
  };
}

function parseCatalogRecommendation(value: unknown): EngineCatalog['recommendation'] {
  const base = parseRecommendation(value);
  return base === null ? null : { ...base, machine: parseMachine(fields(value)?.['machine']) };
}

/** Lenient read of `GET /v1/engines`: unknown fields are dropped, bad entries skipped. */
export function parseEngineCatalog(body: unknown): EngineCatalog {
  const v = fields(body);
  return {
    reachable: v !== null,
    active: parseActive(v?.['active']),
    totalMemoryGb: num(v?.['totalMemoryGb']),
    recommendation: parseCatalogRecommendation(v?.['recommendation']),
    engines: list(v?.['engines'], parseEngine),
    models: list(v?.['models'], parseModel),
    downloads: list(v?.['downloads'], parseDownload),
    paths: parsePaths(v?.['paths']),
    pathsEditable: v?.['pathsEditable'] === true,
    policies: parsePolicyModels(v?.['policies']),
  };
}

/**
 * Poll `GET /v1/engines` while a download runs or a model loads (the default model, or a
 * decision's own); stop once nothing does.
 */
export const ENGINES_POLL_MS = 2500;

export function enginesPollInterval(catalog: EngineCatalog | undefined): number | false {
  if (catalog === undefined) {
    return false;
  }
  const busy =
    catalog.downloads.some((d) => d.state === 'running') ||
    catalog.active?.state === 'starting' ||
    policyModelsStarting(catalog.policies);
  return busy ? ENGINES_POLL_MS : false;
}

/** The engine whose models to list first: the active one, else the first available, else any. */
export function initialEngine(catalog: EngineCatalog): string | null {
  if (catalog.active?.selectionMode === 'auto') {
    return AUTO_ENGINE;
  }
  const active = catalog.active?.engine ?? null;
  if (active !== null && catalog.engines.some((e) => e.id === active)) {
    return active;
  }
  return (catalog.engines.find((e) => e.available) ?? catalog.engines[0])?.id ?? null;
}

export type ModelRowState =
  | { readonly kind: 'in-use'; readonly loading: boolean }
  | { readonly kind: 'switch-device' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'downloading'; readonly progress: number | null }
  | { readonly kind: 'no-fit' }
  | { readonly kind: 'download'; readonly failed: string | null }
  | { readonly kind: 'use' };

export interface ModelRowContext {
  readonly active: ActiveEngine | null;
  readonly downloads: readonly Download[];
  readonly engineAvailable: boolean;
  /** Device chosen on screen; `auto` keeps whatever the gateway uses. */
  readonly device: string;
}

function latestDownload(model: EngineModel, downloads: readonly Download[]): Download | null {
  const mine = downloads.filter((d) => d.engine === model.engine && d.model === model.id);
  return mine.find((d) => d.state === 'running') ?? mine.at(-1) ?? null;
}

function activeState(model: EngineModel, ctx: ModelRowContext): ModelRowState | null {
  const active = ctx.active;
  if (active === null || active.engine !== model.engine || active.model !== model.id) {
    return null;
  }
  const sameDevice =
    ctx.device === 'auto' || active.device === null || active.device === ctx.device;
  return sameDevice
    ? { kind: 'in-use', loading: active.state === 'starting' }
    : { kind: 'switch-device' };
}

/** What a model row shows and offers, in priority order. */
export function modelRowState(model: EngineModel, ctx: ModelRowContext): ModelRowState {
  const active = activeState(model, ctx);
  if (active !== null) {
    return active;
  }
  if (!ctx.engineAvailable) {
    return { kind: 'unavailable' };
  }
  const download = latestDownload(model, ctx.downloads);
  if (download?.state === 'running') {
    return { kind: 'downloading', progress: download.progress };
  }
  if (!model.fits) {
    return { kind: 'no-fit' };
  }
  // A model with no download size is discovered on the endpoint, not fetched by the gateway.
  if (!model.installed && model.downloadGb !== null) {
    return {
      kind: 'download',
      failed: download?.state === 'failed' ? (download.error ?? 'failed') : null,
    };
  }
  return { kind: 'use' };
}

/**
 * True when the gateway can delete the model's files: it was downloaded by the gateway (has a
 * download size), is installed, and is neither the active model nor downloading.
 */
export function canRemoveModel(model: EngineModel, state: ModelRowState): boolean {
  const busy =
    state.kind === 'in-use' || state.kind === 'switch-device' || state.kind === 'downloading';
  return !busy && model.installed && model.downloadGb !== null;
}

export interface ModelRowView {
  readonly label: string;
  readonly hint: string;
  readonly actionLabel: string;
  /** What pressing does; null when the action is disabled. */
  readonly action: 'use' | 'download' | null;
}

export function gb(value: number): string {
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} GB`;
}

/**
 * Typical p50 of the model's fresh benchmark on `device`; null when it was never measured, only
 * measured when stale, or measured on another device. A benchmark without a device (an engine that
 * does not measure per device) stands in when `device` has no entry. A model measured on one device
 * only stands in just when `device` is unknown (null); a named device without a measurement is not
 * guessed from another one.
 */
export function typicalP50(model: EngineModel, device: string | null): number | null {
  const fresh = model.measured.filter((m) => m.freshness !== 'stale' && m.typical !== null);
  const entry =
    fresh.find((m) => m.device === device) ??
    fresh.find((m) => m.device === null) ??
    (device === null && fresh.length === 1 ? fresh[0] : undefined);
  return entry?.typical?.p50Ms ?? null;
}

/**
 * The device an engine runs on: the one asked for, else the one the default model resolved to
 * when it runs on that engine, else the engine's only device. Any other engine with several
 * devices stays null: the catalog cannot say which one `auto` picks there.
 */
export function deviceFor(
  catalog: EngineCatalog,
  engine: string,
  requested: string | null | undefined,
): string | null {
  if (requested != null && requested !== 'auto') {
    return requested;
  }
  const active = catalog.active;
  if (active?.engine !== engine) {
    const devices = catalog.engines.find((e) => e.id === engine)?.devices ?? [];
    return devices.length === 1 ? (devices[0] ?? null) : null;
  }
  const resolved = active.resolvedDevice ?? active.device;
  return resolved === 'auto' ? null : resolved;
}

/** The fresh typical p50s of the model on every device it was measured on, fastest first. */
function freshP50s(model: EngineModel): number[] {
  return model.measured
    .filter((m) => m.freshness !== 'stale')
    .flatMap((m) => (m.typical === null ? [] : [m.typical.p50Ms]))
    .toSorted((a, b) => a - b);
}

/**
 * The fresh measurement on `device` as a duration: `350 ms`. When the device is unknown and the
 * model was measured on several, the range `1.4 s to 5.5 s`, because any of them may run it.
 * Null when there is no fresh measurement for it.
 */
export function measuredDuration(model: EngineModel, device: string | null): string | null {
  const p50 = typicalP50(model, device);
  if (p50 !== null) {
    return ms(p50);
  }
  const all = device === null ? freshP50s(model) : [];
  const fastest = all[0];
  const slowest = all.at(-1);
  if (fastest === undefined || slowest === undefined) {
    return null;
  }
  return ms(fastest) === ms(slowest) ? ms(fastest) : `${ms(fastest)} to ${ms(slowest)}`;
}

/** `~{duration} here` for a fresh measurement on `device`; null when there is none. */
export function measuredSpeed(model: EngineModel, device: string | null): string | null {
  const duration = measuredDuration(model, device);
  return duration === null ? null : `~${duration} here`;
}

/** The measurement, else the catalog's figure labelled as a reference. */
function speedFact(model: EngineModel, device: string | null): string | null {
  const measured = measuredSpeed(model, device);
  if (measured !== null) {
    return measured;
  }
  return model.latencyHint === null ? null : `reference: ${model.latencyHint}`;
}

function facts(model: EngineModel, device: string | null): string[] {
  const parts: string[] = [];
  if (model.downloadGb !== null) {
    parts.push(`${gb(model.downloadGb)} download`);
  }
  if (model.memoryGb !== null) {
    parts.push(`${gb(model.memoryGb)} memory`);
  }
  const speed = speedFact(model, device);
  if (speed !== null) {
    parts.push(speed);
  }
  return parts;
}

function stateNote(
  state: ModelRowState,
  model: EngineModel,
  totalGb: number | null,
): string | null {
  switch (state.kind) {
    case 'in-use':
      return state.loading ? 'Loading; decisions fail open until it is ready.' : null;
    case 'unavailable':
      return 'This engine is not available here.';
    case 'no-fit': {
      const need = model.memoryGb === null ? 'more memory' : `~${gb(model.memoryGb)}`;
      return totalGb === null
        ? `Needs ${need}.`
        : `Needs ${need}; this machine has ${gb(totalGb)}.`;
    }
    case 'download':
      return state.failed === null ? null : `Download failed: ${state.failed}`;
    default:
      return null;
  }
}

function actionFor(
  state: ModelRowState,
  model: EngineModel,
  device: string,
): Omit<ModelRowView, 'label' | 'hint'> {
  switch (state.kind) {
    case 'in-use':
      return { actionLabel: state.loading ? 'Loading…' : 'In use', action: null };
    case 'switch-device':
      return { actionLabel: `Use on ${deviceLabel(device)}`, action: 'use' };
    case 'unavailable':
      return { actionLabel: 'Unavailable', action: null };
    case 'downloading':
      return { actionLabel: 'Downloading…', action: null };
    case 'no-fit':
      return {
        actionLabel: model.memoryGb === null ? 'Does not fit' : `Needs ~${gb(model.memoryGb)}`,
        action: null,
      };
    case 'download': {
      const size = model.downloadGb === null ? '' : ` (${gb(model.downloadGb)})`;
      return {
        actionLabel: `${state.failed === null ? 'Download' : 'Retry download'}${size}`,
        action: 'download',
      };
    }
    default:
      return { actionLabel: 'Use', action: 'use' };
  }
}

/** Label, hint and action of a model row, e.g. `Download (2.0 GB)` or `In use`. */
export function modelRowView(
  model: EngineModel,
  state: ModelRowState,
  options: {
    readonly device: string;
    /** The device the speed is measured on, from `deviceFor`; null when it cannot be told. */
    readonly speedDevice: string | null;
    readonly totalMemoryGb: number | null;
  },
): ModelRowView {
  const note = stateNote(state, model, options.totalMemoryGb);
  return {
    label: model.recommended ? `${model.label} · Recommended` : model.label,
    hint: [...facts(model, options.speedDevice), ...(note === null ? [] : [note])].join(' · '),
    ...actionFor(state, model, options.device),
  };
}

const DEVICE_LABELS: Record<string, string> = {
  auto: 'Gateway default',
  cpu: 'CPU',
  mlx: 'GPU (MLX)',
  mps: 'GPU (MPS)',
  // ROCm torch names AMD GPUs `cuda` too.
  cuda: 'GPU (CUDA or ROCm)',
};

function deviceLabel(device: string): string {
  return DEVICE_LABELS[device] ?? device;
}

/** Device select options for an engine that lists devices: "Gateway default" first. */
export function deviceOptions(devices: readonly string[]): { label: string; value: string }[] {
  const ids = ['auto', ...devices.filter((d) => d !== 'auto')];
  return ids.map((d) => ({ label: deviceLabel(d), value: d }));
}

/**
 * A few characters naming the engine, for the sidebar and popover: `NPU`, `PyTorch`. The tag
 * comes from the gateway (`/health` `engineTag`); an old gateway sends none, so use the id.
 */
export function engineTag(engine: string | null, tag: string | null = null): string | null {
  if (engine === null || engine === '') {
    return null;
  }
  return tag === null || tag === '' ? engine : tag;
}

/** The active engine's tag from the catalog, for callers without a `/health` answer. */
export function activeEngineTag(catalog: EngineCatalog): string | null {
  const id = catalog.active?.engine ?? null;
  return engineTag(id, catalog.engines.find((e) => e.id === id)?.tag ?? null);
}

/**
 * Engine select options; an unavailable engine says so in its label. An unsupported engine is
 * hidden unless it is the active one.
 */
export function engineOptions(
  engines: readonly EngineInfo[],
  activeId: string | null = null,
  withAuto = false,
): { label: string; value: string }[] {
  const options = engines
    .filter((e) => e.supported || e.id === activeId)
    .map((e) => ({
      label: e.available ? e.label : `${e.label} (${unavailableWord(e)})`,
      value: e.id,
    }));
  return withAuto ? [{ label: AUTO_OPTION_LABEL, value: AUTO_ENGINE }, ...options] : options;
}

function unavailableWord(e: EngineInfo): string {
  if (e.installed) {
    return 'unavailable';
  }
  return e.connectable ? 'not configured' : 'not installed';
}

/** Hint under the engine select: what the engine is, then where it runs and whether it is usable. */
export function engineHint(engine: EngineInfo | null, where: string | null = null): string {
  if (engine === null) {
    return 'The gateway lists no engines.';
  }
  const status = engineStatus(engine, where);
  return engine.description === '' ? status : `${engine.description}. ${status}`;
}

function engineStatus(engine: EngineInfo, where: string | null): string {
  if (!engine.supported) {
    return engine.unsupportedReason ?? 'Not supported here.';
  }
  let state = 'not installed';
  if (engine.available) {
    state = 'ready';
  } else if (engine.installed) {
    state = 'unavailable here';
  } else if (engine.connectable) {
    return "Not configured yet. Enter your server's URL below.";
  }
  return where === null
    ? `${state.charAt(0).toUpperCase()}${state.slice(1)}.`
    : `Runs on ${where} · ${state}`;
}
