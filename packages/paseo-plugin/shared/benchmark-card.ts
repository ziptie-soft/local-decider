/**
 * The "Benchmark" settings card as a pure view model: one table of installed models (rows) by
 * the processor they run on (columns: NPU, GPU (Vulkan), CPU, …), each cell one number — the
 * median time of one decision — plus the run's progress, end state and what failed.
 */
import type { BenchmarkTarget, BenchmarkView } from './benchmark.ts';
import type { EngineCatalog, EngineModel } from './engines.ts';
import type { Measured } from './machine.ts';
import { backendOf } from './recommendation.ts';
import { ms, runtimeName } from './recommended-card.ts';

export type BenchActionKind = 'run' | 'missing' | 'cancel' | 'retry' | 'restore' | 'auto';

export interface BenchTarget {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
}

export interface BenchAction {
  readonly kind: BenchActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly hint: string | null;
  /** `missing` measures only pairs without a current result. */
  readonly only: 'missing' | null;
  /** The pairs to run, or the one to switch back to; empty otherwise. */
  readonly targets: readonly BenchTarget[];
  /** The family for `auto`. */
  readonly family: string | null;
}

/**
 * `time` a measured median; `failed` the last attempt failed; `missing` installed but never
 * measured; `queued`/`loading`/`measuring` the running job; `none` no variant for this processor.
 */
export type CellKind = 'time' | 'failed' | 'missing' | 'queued' | 'loading' | 'measuring' | 'none';

export interface Cell {
  readonly column: string;
  readonly kind: CellKind;
  /** `1.5 s`, `Failed`, `Not measured`, `Measuring…`, `—`. */
  readonly text: string;
  /** The format, when this model has more than one on this processor (`Q4_K_M`). */
  readonly format: string | null;
  readonly fastest: boolean;
  readonly inUse: boolean;
  /** The runtime or model changed since it was measured. */
  readonly stale: boolean;
  /** Too slow for live decisions (the CPU): never the fastest, and a run skips it. */
  readonly background: boolean;
  readonly accessibleName: string;
}

export interface Column {
  readonly key: string;
  readonly label: string;
}

export interface Row {
  readonly family: string;
  readonly label: string;
  readonly inUse: boolean;
  readonly cells: readonly Cell[];
}

/** One failed pair, with its error and a Retry that names the pair. */
export interface Problem {
  readonly key: string;
  readonly text: string;
  readonly retry: BenchAction;
}

export interface BenchmarkCard {
  readonly state: 'idle' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'failed';
  readonly stateLabel: string | null;
  readonly description: string;
  /** "7 pairs · about 2 min": what a run covers and how long it takes. */
  readonly summary: string | null;
  readonly primary: BenchAction;
  readonly secondary: readonly BenchAction[];
  readonly activity: string | null;
  readonly progress: {
    readonly completed: number;
    readonly total: number;
    readonly fraction: number;
    readonly text: string;
  } | null;
  readonly note: string | null;
  readonly status: string | null;
  /** Live-region text. It changes only when a pair finishes or the job ends, not per tick. */
  readonly announcement: string | null;
  readonly restoreFailure: {
    readonly text: string;
    readonly retry: BenchAction;
    readonly auto: BenchAction;
  } | null;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /** How to read the table; null without rows. */
  readonly legend: string | null;
  readonly problems: readonly Problem[];
  readonly footer: readonly string[];
}

const DESCRIPTION =
  'How long one decision takes for each installed model on each processor of this machine. Lower is faster.';
const LEGEND =
  'Median time of one decision on a typical request (about 1,000 tokens), after a warm-up. — means the model has no version for that processor.';
const BUSY_HINT = 'Available when the benchmark finishes.';
const RUNNING_NOTE = 'Decisions are passed to you until it finishes; your setup comes back after.';
const MACHINE_ONLY = 'Results are from this machine only.';
const MAX_ERROR = 160;

function action(
  kind: BenchActionKind,
  label: string,
  rest: Partial<BenchAction> = {},
): BenchAction {
  return {
    kind,
    label,
    disabled: false,
    hint: null,
    only: null,
    targets: [],
    family: null,
    ...rest,
  };
}

// ── sources: one per (engine, model, device) the table can show ──────────────────────────────

interface Source {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly family: { id: string; label: string };
  readonly format: string | null;
  readonly measured: Measured | null;
  /** The gateway calls this runtime too slow for live decisions (the CPU). */
  readonly background: boolean;
}

interface Ctx {
  readonly catalog: EngineCatalog;
  readonly view: BenchmarkView | null;
  readonly busy: boolean;
  readonly targets: ReadonlyMap<string, BenchmarkTarget>;
}

function keyOf(t: { engine: string; model: string; device: string | null }): string {
  return `${t.engine}|${t.model}|${t.device ?? ''}`;
}

function familyOf(m: EngineModel): { id: string; label: string } {
  return m.family ?? { id: `${m.engine}:${m.id}`, label: m.label };
}

/** Whether a run could measure this model now, mirroring the gateway's target filter. */
function runnable(catalog: EngineCatalog, m: EngineModel): boolean {
  const e = catalog.engines.find((x) => x.id === m.engine);
  return (
    e !== undefined &&
    e.supported &&
    e.installed &&
    e.available &&
    e.calibrated &&
    m.installed &&
    m.fits
  );
}

/** The concrete devices a model is measured on: strands per device, the others once. */
function devicesOf(catalog: EngineCatalog, m: EngineModel): (string | null)[] {
  const listed = catalog.engines.find((e) => e.id === m.engine)?.devices ?? [];
  const concrete = listed.filter((d) => d !== 'auto');
  return concrete.length > 0 ? concrete : [null];
}

/** Whether the gateway marks this runtime too slow to pick automatically (the CPU). */
function tooSlow(catalog: EngineCatalog, engine: string, device: string | null): boolean {
  const rec = catalog.recommendation;
  const same = (x: { engine: string; device: string | null }): boolean =>
    x.engine === engine && x.device === device;
  return (
    rec?.candidates.some((x) => same(x) && x.code === 'too-slow') === true ||
    rec?.machine?.runtimes.some((x) => same(x) && x.pick?.code === 'too-slow') === true
  );
}

/** Unmeasured too-slow pairs are left out: a run skips them, so they would never fill in. */
function sourcesOf(catalog: EngineCatalog): Source[] {
  const out: Source[] = [];
  for (const m of catalog.models.filter((x) => runnable(catalog, x))) {
    const base = {
      engine: m.engine,
      model: m.id,
      family: familyOf(m),
      format: m.format?.short ?? null,
    };
    for (const device of devicesOf(catalog, m)) {
      const measured = m.measured.find((x) => x.device === device) ?? null;
      const background = tooSlow(catalog, m.engine, device);
      if (!background || measured !== null) {
        out.push({ ...base, device, measured, background });
      }
    }
  }
  return out;
}

/** A job target the catalog does not list (yet), so its progress still shows. */
function withJobTargets(c: Ctx): Source[] {
  const sources = sourcesOf(c.catalog);
  const known = new Set(sources.map(keyOf));
  for (const t of c.view?.targets ?? []) {
    if (known.has(keyOf(t))) continue;
    const id = t.family ?? `${t.engine}:${t.model}`;
    const label = c.catalog.models.find((m) => m.family?.id === id)?.family?.label ?? t.model;
    const background = tooSlow(c.catalog, t.engine, t.device);
    sources.push({ ...t, family: { id, label }, format: null, measured: null, background });
  }
  return sources;
}

// ── processors ───────────────────────────────────────────────────────────────────────────────

/** The backend the gateway reports for a runtime (ROCm vs CUDA), else one from the device. */
function backendFor(catalog: EngineCatalog, engine: string, device: string | null): string | null {
  const rec = catalog.recommendation;
  const hit =
    rec?.candidates.find((x) => x.engine === engine && x.device === device)?.backend ??
    rec?.machine?.runtimes.find((x) => x.engine === engine && x.device === device)?.backend;
  return hit ?? backendOf(engine, device);
}

function processorOf(catalog: EngineCatalog, s: { engine: string; device: string | null }): string {
  return runtimeName(catalog, {
    engine: s.engine,
    device: s.device,
    backend: backendFor(catalog, s.engine, s.device),
  });
}

function columnRank(label: string): number {
  if (label === 'NPU') return 0;
  if (label.startsWith('GPU')) return 1;
  return label === 'CPU' ? 2 : 3;
}

function columnsOf(labels: Iterable<string>): Column[] {
  return [...new Set(labels)]
    .toSorted((a, b) => columnRank(a) - columnRank(b) || a.localeCompare(b))
    .map((label) => ({ key: label, label }));
}

// ── one pair's state ─────────────────────────────────────────────────────────────────────────

type PairState =
  | { kind: 'time'; p50: number; stale: boolean }
  | { kind: 'failed'; error: string }
  | { kind: 'missing' | 'queued' | 'loading' | 'measuring' };

const LIVE: Readonly<Record<string, 'queued' | 'loading' | 'measuring'>> = {
  pending: 'queued',
  loading: 'loading',
  measuring: 'measuring',
};

function jobTime(t: BenchmarkTarget): number | null {
  const typical = t.sizes.find((s) => s.targetTokens === 1024 && s.p50Ms !== null);
  return typical?.p50Ms ?? t.sizes.find((s) => s.p50Ms !== null)?.p50Ms ?? null;
}

/** What this run says about the pair, if anything: live progress, a new time or a failure. */
function fromJob(c: Ctx, t: BenchmarkTarget | undefined): PairState | null {
  const live = t?.state == null ? undefined : LIVE[t.state];
  if (live !== undefined) {
    return c.busy ? { kind: live } : null;
  }
  if (t?.state === 'failed') {
    return { kind: 'failed', error: t.error ?? 'failed' };
  }
  const p50 = t?.state === 'done' ? jobTime(t) : null;
  return p50 === null ? null : { kind: 'time', p50, stale: false };
}

function fromStore(m: Measured | null): PairState {
  if (m?.failed != null) {
    return { kind: 'failed', error: m.failed.error };
  }
  const p50 = m?.typical?.p50Ms ?? m?.sizes.find((s) => s.targetTokens === 1024)?.p50Ms;
  return p50 == null ? { kind: 'missing' } : { kind: 'time', p50, stale: m?.freshness === 'stale' };
}

interface Pair {
  readonly source: Source;
  readonly processor: string;
  readonly state: PairState;
}

function pairOf(c: Ctx, s: Source): Pair {
  return {
    source: s,
    processor: processorOf(c.catalog, s),
    state: fromJob(c, c.targets.get(keyOf(s))) ?? fromStore(s.measured),
  };
}

// ── cells ────────────────────────────────────────────────────────────────────────────────────

function isActive(c: Ctx, s: Source): boolean {
  const a = c.catalog.active;
  if (a === null || a.engine !== s.engine || a.model !== s.model) {
    return false;
  }
  return s.device === null || a.device === s.device || a.resolvedDevice === s.device;
}

const LIVE_ORDER = ['measuring', 'loading', 'queued'] as const;

const TEXT: Readonly<Record<Exclude<CellKind, 'time'>, string>> = {
  failed: 'Failed',
  missing: 'Not measured',
  queued: 'Queued',
  loading: 'Loading…',
  measuring: 'Measuring…',
  none: '—',
};

/** The pair a cell shows: live first, then the quickest result (current before stale), then a failure. */
function pickPair(pairs: readonly Pair[]): Pair | undefined {
  for (const kind of LIVE_ORDER) {
    const live = pairs.find((p) => p.state.kind === kind);
    if (live !== undefined) return live;
  }
  const times = pairs.flatMap((p) => (p.state.kind === 'time' ? [{ p, t: p.state }] : []));
  const best = times.toSorted(
    (a, b) => Number(a.t.stale) - Number(b.t.stale) || a.t.p50 - b.t.p50,
  )[0];
  return best?.p ?? pairs.find((p) => p.state.kind === 'failed') ?? pairs[0];
}

function cellText(state: PairState | undefined): string {
  if (state === undefined) return TEXT.none;
  return state.kind === 'time' ? ms(state.p50) : TEXT[state.kind];
}

function cellAccessible(model: string, column: string, cell: Omit<Cell, 'accessibleName'>): string {
  const parts = [`${model} on ${column}`, cell.kind === 'none' ? 'not available' : cell.text];
  if (cell.format !== null) parts.push(`${cell.format} format`);
  if (cell.fastest) parts.push('fastest');
  if (cell.inUse) parts.push('in use');
  if (cell.stale) parts.push('out of date');
  if (cell.background) parts.push('too slow for live decisions');
  return parts.join(', ');
}

function cellOf(c: Ctx, label: string, column: string, pairs: readonly Pair[]): Cell {
  const pick = pickPair(pairs);
  const state = pick?.state;
  const cell: Omit<Cell, 'accessibleName'> = {
    column,
    kind: state?.kind ?? 'none',
    text: cellText(state),
    format: pairs.length > 1 ? (pick?.source.format ?? null) : null,
    fastest: false,
    inUse: pairs.some((p) => isActive(c, p.source)),
    stale: state?.kind === 'time' && state.stale,
    background: pick?.source.background ?? false,
  };
  return { ...cell, accessibleName: cellAccessible(label, column, cell) };
}

/** Marks the quickest current time of a row, when the row has two or more times to compare. */
function markFastest(label: string, cells: Cell[], pairs: ReadonlyMap<string, Pair[]>): Cell[] {
  const timed = cells.flatMap((cell) => {
    const state = pickPair(pairs.get(cell.column) ?? [])?.state;
    return cell.kind === 'time' && state?.kind === 'time' ? [{ cell, p50: state.p50 }] : [];
  });
  const current = timed.filter((x) => !x.cell.stale && !x.cell.background);
  if (timed.length < 2 || current.length === 0) {
    return cells;
  }
  const best = current.reduce((a, x) => (x.p50 < a.p50 ? x : a)).cell;
  return cells.map((cell) => {
    if (cell !== best) return cell;
    const marked = { ...cell, fastest: true };
    return { ...marked, accessibleName: cellAccessible(label, cell.column, marked) };
  });
}

function rowOf(
  c: Ctx,
  family: { id: string; label: string },
  pairs: Pair[],
  columns: Column[],
): Row {
  const byColumn = new Map<string, Pair[]>();
  for (const p of pairs) {
    byColumn.set(p.processor, [...(byColumn.get(p.processor) ?? []), p]);
  }
  const cells = columns.map((col) => cellOf(c, family.label, col.key, byColumn.get(col.key) ?? []));
  return {
    family: family.id,
    label: family.label,
    inUse: cells.some((x) => x.inUse),
    cells: markFastest(family.label, cells, byColumn),
  };
}

interface Table {
  readonly columns: Column[];
  readonly rows: Row[];
  readonly pairs: Pair[];
}

/** Rows sorted by name so they never move under the pointer while results come in. */
function tableOf(c: Ctx): Table {
  const pairs = withJobTargets(c).map((s) => pairOf(c, s));
  const columns = columnsOf(pairs.map((p) => p.processor));
  const families = new Map<string, { label: string; pairs: Pair[] }>();
  for (const p of pairs) {
    const slot = families.get(p.source.family.id) ?? { label: p.source.family.label, pairs: [] };
    slot.pairs.push(p);
    families.set(p.source.family.id, slot);
  }
  const rows = [...families]
    .map(([id, f]) => rowOf(c, { id, label: f.label }, f.pairs, columns))
    .toSorted((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return { columns, rows, pairs };
}

// ── problems ─────────────────────────────────────────────────────────────────────────────────

function oneLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR)}…` : line;
}

function lockable(c: Ctx, a: BenchAction): BenchAction {
  return c.busy ? { ...a, disabled: true, hint: BUSY_HINT } : a;
}

/** `d3 mini on GPU (Vulkan)`, with the format when the model has several there. */
function pairName(p: Pair, pairs: readonly Pair[]): string {
  const several = pairs.some(
    (q) => q !== p && q.source.family.id === p.source.family.id && q.processor === p.processor,
  );
  const format = several && p.source.format !== null ? ` ${p.source.format}` : '';
  return `${p.source.family.label}${format} on ${p.processor}`;
}

function problemsOf(c: Ctx, pairs: readonly Pair[]): Problem[] {
  return pairs.flatMap((p) => {
    if (p.state.kind !== 'failed') return [];
    const name = pairName(p, pairs);
    const { engine, model, device } = p.source;
    return [
      {
        key: keyOf(p.source),
        text: `${name}: ${oneLine(p.state.error)}`,
        retry: lockable(
          c,
          action('retry', `Retry ${name}`, { targets: [{ engine, model, device }] }),
        ),
      },
    ];
  });
}

// ── progress and end states ──────────────────────────────────────────────────────────────────

function minutesText(seconds: number): string {
  return `${String(Math.max(1, Math.ceil(seconds / 60)))} min`;
}

function nameOf(
  c: Ctx,
  w: { engine: string; model: string; device: string | null; family: string | null },
): string {
  const hit = c.catalog.models.find(
    (m) =>
      (w.family !== null && m.family?.id === w.family) ||
      (m.engine === w.engine && m.id === w.model),
  );
  const label = hit === undefined ? w.model : familyOf(hit).label;
  return `${label} on ${processorOf(c.catalog, w)}`;
}

function activityOf(c: Ctx, v: BenchmarkView): string | null {
  if (v.phase === 'restoring') {
    return 'Switching back to your setup…';
  }
  const cur = v.current;
  if (cur === null || v.phase === null) {
    return null;
  }
  return v.phase === 'loading' ? `Loading ${nameOf(c, cur)}…` : `Timing ${nameOf(c, cur)}…`;
}

function progressOf(v: BenchmarkView): NonNullable<BenchmarkCard['progress']> {
  const eta = v.etaSeconds === null ? '' : ` · about ${minutesText(v.etaSeconds)} left`;
  return {
    completed: v.completed,
    total: v.total,
    fraction: v.total > 0 ? Math.min(1, v.completed / v.total) : 0,
    text: `${String(v.completed)} of ${String(v.total)} done${eta}`,
  };
}

function restoreName(c: Ctx, v: BenchmarkView): string | null {
  const r = v.restore;
  if (r?.engine == null || r.model == null) {
    return null;
  }
  return nameOf(c, { engine: r.engine, model: r.model, device: r.device, family: r.family });
}

function fastestText(c: Ctx, v: BenchmarkView): string | null {
  const done = v.targets.flatMap((t) => {
    const p50 = t.state === 'done' ? jobTime(t) : null;
    return p50 === null ? [] : [{ t, p50 }];
  });
  if (done.length < 2) {
    return null;
  }
  const best = done.reduce((a, x) => (x.p50 < a.p50 ? x : a));
  return ` Fastest: ${nameOf(c, best.t)}, ${ms(best.p50)}.`;
}

function backNote(c: Ctx, v: BenchmarkView): string {
  const name = v.restoredOk === true ? restoreName(c, v) : null;
  return name === null ? '' : ` ${name} is back in use.`;
}

function doneStatus(c: Ctx, v: BenchmarkView): string {
  const ok = v.total - v.failed;
  const failed = `${String(v.failed)} failed (see Failed below).`;
  const head =
    v.failed === 0
      ? `Done: measured ${plural(v.total, 'pair', 'pairs')}.`
      : `Done: ${ok === 0 ? '' : `${String(ok)} measured, `}${failed}`;
  return `${head}${fastestText(c, v) ?? ''}${backNote(c, v)}`;
}

function cancelledStatus(c: Ctx, v: BenchmarkView): string {
  switch (v.cancelReason) {
    case 'superseded':
    case 'config-changed':
      return 'Stopped because the engine selection changed. Finished results are kept.';
    case 'shutdown':
      return 'Stopped because the gateway stopped. Finished results are kept.';
    default:
      return `Cancelled after ${String(v.completed)} of ${String(v.total)}. Finished results are kept.${backNote(c, v)}`;
  }
}

function statusOf(c: Ctx, v: BenchmarkView): string | null {
  switch (v.state) {
    case 'done':
      return doneStatus(c, v);
    case 'cancelled':
      return cancelledStatus(c, v);
    case 'failed':
      return `The benchmark stopped: ${v.error ?? 'unknown error'}. Finished results are kept.`;
    default:
      return null;
  }
}

function announcementOf(v: BenchmarkView, status: string | null): string | null {
  if (v.state !== 'running' && v.state !== 'cancelling') {
    return status;
  }
  if (v.completed === 0) {
    return null;
  }
  const failed = v.failed > 0 ? `, ${String(v.failed)} failed` : '';
  return `${String(v.completed)} of ${String(v.total)} done${failed}`;
}

function restoreFailure(c: Ctx, v: BenchmarkView): BenchmarkCard['restoreFailure'] {
  if (v.restoredOk !== false) {
    return null;
  }
  const name = restoreName(c, v) ?? 'your setup';
  const why = v.restoreError === null ? '' : `: ${v.restoreError}`;
  const r = v.restore;
  const targets =
    r?.engine == null || r.model == null
      ? []
      : [{ engine: r.engine, model: r.model, device: r.device }];
  return {
    text: `Couldn't switch back to ${name}${why}. Decisions are passed to you until an engine is running.`,
    retry: action('restore', 'Try again', { targets }),
    auto: action('auto', 'Use automatic', { family: r?.family ?? null }),
  };
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────

function isRunning(v: BenchmarkView | null): boolean {
  return v?.state === 'running' || v?.state === 'cancelling';
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function summaryOf(v: BenchmarkView | null): string | null {
  const p = v?.preview;
  if (p == null || p.total === 0 || isRunning(v)) {
    return null;
  }
  const time = p.etaSeconds === null ? '' : ` · about ${minutesText(p.etaSeconds)}`;
  return `A full run times ${plural(p.total, 'model–processor pair', 'model–processor pairs')}${time}.`;
}

function runAction(v: BenchmarkView | null, label: string): BenchAction {
  if (v === null) {
    return action('run', label, {
      disabled: true,
      hint: "Benchmarking isn't available on this gateway.",
    });
  }
  if (v.preview?.total === 0) {
    return action('run', label, {
      disabled: true,
      hint: 'Install a model first; see the recommendation above.',
    });
  }
  return action('run', label);
}

interface Actions {
  readonly primary: BenchAction;
  readonly secondary: BenchAction[];
}

function actionsOf(c: Ctx, table: Table): Actions {
  const v = c.view;
  if (v?.state === 'running') {
    return { primary: action('cancel', 'Cancel benchmark'), secondary: [] };
  }
  if (v?.state === 'cancelling') {
    return { primary: action('cancel', 'Cancelling…', { disabled: true }), secondary: [] };
  }
  const measured = table.pairs.some((p) => p.state.kind === 'time');
  const live = table.pairs.filter((p) => !p.source.background);
  const gaps = live.some((p) => p.state.kind !== 'time' || p.state.stale);
  const run = lockable(c, runAction(v, measured ? 'Run again' : 'Run benchmark'));
  if (!measured || !gaps) {
    return { primary: run, secondary: [] };
  }
  const missing = lockable(c, action('missing', 'Measure missing only', { only: 'missing' }));
  return v?.state === 'cancelled'
    ? { primary: missing, secondary: [run] }
    : { primary: run, secondary: [missing] };
}

function footerOf(c: Ctx, table: Table): string[] {
  const out: string[] = [];
  if (table.rows.length > 0) {
    out.push(MACHINE_ONLY);
  }
  if (table.pairs.some((p) => p.source.background)) {
    out.push(
      'Background only: the CPU takes too long for live decisions, so automatic never picks it and a run skips it.',
    );
  }
  const excluded = c.view?.preview?.excluded ?? [];
  if (excluded.length > 0) {
    const names = excluded.map((id) => c.catalog.engines.find((e) => e.id === id)?.label ?? id);
    out.push(`Custom servers aren't benchmarked (${names.join(', ')}).`);
  }
  return out;
}

function stateLabel(v: BenchmarkView | null): string | null {
  if (v?.state === 'running') return 'Running';
  return v?.state === 'cancelling' ? 'Cancelling' : null;
}

type JobParts = Pick<
  BenchmarkCard,
  'activity' | 'progress' | 'note' | 'status' | 'announcement' | 'restoreFailure'
>;

const NO_JOB: JobParts = {
  activity: null,
  progress: null,
  note: null,
  status: null,
  announcement: null,
  restoreFailure: null,
};

/** The parts that follow the job: live progress while it runs, the end state after. */
function jobParts(c: Ctx, v: BenchmarkView | null): JobParts {
  if (v === null) {
    return NO_JOB;
  }
  const running = isRunning(v);
  const status = statusOf(c, v);
  return {
    activity: running ? activityOf(c, v) : null,
    progress: running ? progressOf(v) : null,
    note: running ? RUNNING_NOTE : null,
    status,
    announcement: announcementOf(v, status),
    restoreFailure: restoreFailure(c, v),
  };
}

/** The card for the job view (null when the gateway has no benchmark) and the engines catalog. */
export function benchmarkCard(view: BenchmarkView | null, catalog: EngineCatalog): BenchmarkCard {
  const c: Ctx = {
    catalog,
    view,
    busy: isRunning(view) || catalog.active?.benchmark != null,
    targets: new Map((view?.targets ?? []).map((t) => [keyOf(t), t])),
  };
  const table = tableOf(c);
  const actions = actionsOf(c, table);
  return {
    ...jobParts(c, view),
    state: view?.state ?? 'idle',
    stateLabel: stateLabel(view),
    description: DESCRIPTION,
    summary: summaryOf(view),
    primary: actions.primary,
    secondary: actions.secondary,
    columns: table.columns,
    rows: table.rows,
    legend: table.rows.length > 0 ? LEGEND : null,
    problems: problemsOf(c, table.pairs),
    footer: footerOf(c, table),
  };
}
