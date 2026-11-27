/** The engine's load lifecycle: plain-language state notes and the idle-time choice. */
import { shortModel } from './models.ts';

export const IDLE_MINUTES = { min: 1, max: 1440, fallback: 15 } as const;

export interface EngineStateLike {
  readonly state: string | null;
  readonly detail: string | null;
  readonly model: string | null;
  /** Short engine tag, e.g. `NPU`. */
  readonly engineTag: string | null;
  readonly lifecycle?: 'lazy' | 'eager' | null;
  /** Progress of a running benchmark job. */
  readonly benchmark?: { readonly completed: number; readonly total: number } | null;
}

function loadedNote(s: EngineStateLike): string {
  const parts = ['Loaded'];
  if (s.model !== null && s.model !== '') {
    parts.push(shortModel(s.model));
  }
  if (s.engineTag !== null) {
    parts.push(s.engineTag);
  }
  return parts.join(' · ');
}

/**
 * `Loaded · d3:nano · NPU`, `Unloaded · loads automatically on the next decision`, `Loading…`,
 * `Failed: <detail>`, and `Benchmarking (3 of 6)` while a benchmark runs.
 */
function stateNote(s: EngineStateLike | undefined): string {
  switch (s?.state ?? null) {
    case 'ready':
      return loadedNote(s as EngineStateLike);
    case 'starting':
      return 'Loading…';
    case 'failed':
      return `Failed: ${s?.detail ?? 'no detail from the gateway'}`;
    case 'stopped':
      return s?.lifecycle === 'eager'
        ? 'Unloaded · press Load now to load it'
        : 'Unloaded · loads automatically on the next decision';
    case null:
      return 'Engine state unknown';
    default:
      return s?.state ?? 'Engine state unknown';
  }
}

export function engineStateNote(s: EngineStateLike | undefined): string {
  const b = s?.benchmark;
  return b == null ? stateNote(s) : `Benchmarking (${String(b.completed)} of ${String(b.total)})`;
}

export type LifecycleChoice = 'lazy' | 'eager';

export function lifecycleLabel(choice: LifecycleChoice, minutes: number | null): string {
  return choice === 'eager'
    ? 'Always loaded'
    : `Automatic: load on demand, unload after ${String(minutes ?? IDLE_MINUTES.fallback)} min idle`;
}

/** The engine's state as a sentence: `Not loaded; loads on the next decision.`, `Loaded.`, … */
export function engineStateSentence(s: EngineStateLike | undefined): string {
  const b = s?.benchmark;
  if (b != null) {
    return `Benchmarking (${String(b.completed)} of ${String(b.total)})`;
  }
  const state = s?.state ?? null;
  switch (state) {
    case 'ready':
      return 'Loaded.';
    case 'starting':
      return 'Loading…';
    case 'failed': {
      const detail = s?.detail ?? 'no detail from the gateway';
      return `Failed: ${detail}${detail.endsWith('.') ? '' : '.'}`;
    }
    case 'stopped':
      return s?.lifecycle === 'eager'
        ? 'Not loaded; press Load now.'
        : 'Not loaded; loads on the next decision.';
    case null:
      return 'State unknown.';
    default:
      return `${state}.`;
  }
}

/** The idle times offered as presets, in minutes. */
const IDLE_PRESETS = [5, 15, 30, 60, 240] as const;

/** The select value of "Never (stay loaded)": the lazy ones are their minutes. */
const NEVER = 'never';

const PRESET_LABELS: Readonly<Record<number, string>> = {
  60: 'After 1 hour',
  240: 'After 4 hours',
};

export interface IdleOption {
  readonly label: string;
  readonly value: string;
}

/** What the "Unload when idle" select sets: always loaded, or lazy with its idle minutes. */
export type IdleChoice =
  | { readonly lifecycle: 'eager' }
  | { readonly lifecycle: 'lazy'; readonly idleUnloadMinutes: number };

function idleLabel(minutes: number): string {
  return PRESET_LABELS[minutes] ?? `After ${String(minutes)} min`;
}

/**
 * The "Unload when idle" options: the presets, plus the current idle time in numeric order when
 * it is none of them (so the current value is always selectable), then "Never (stay loaded)".
 */
export function idleOptions(lifecycle: LifecycleChoice, minutes: number | null): IdleOption[] {
  const current = lifecycle === 'lazy' ? (minutes ?? IDLE_MINUTES.fallback) : null;
  const all = new Set<number>(IDLE_PRESETS);
  if (current !== null) {
    all.add(current);
  }
  return [
    ...[...all].toSorted((a, b) => a - b).map((m) => ({ label: idleLabel(m), value: String(m) })),
    { label: 'Never (stay loaded)', value: NEVER },
  ];
}

/** The select value for the engine's lifecycle and idle minutes. */
export function idleValue(lifecycle: LifecycleChoice, minutes: number | null): string {
  return lifecycle === 'eager' ? NEVER : String(minutes ?? IDLE_MINUTES.fallback);
}

/** The lifecycle a select value stands for; `Never` is eager. */
export function parseIdleValue(value: string): IdleChoice {
  const minutes = Number(value);
  if (value === NEVER) {
    return { lifecycle: 'eager' };
  }
  return {
    lifecycle: 'lazy',
    idleUnloadMinutes: Number.isInteger(minutes) ? minutes : IDLE_MINUTES.fallback,
  };
}

/** The hint under "Unload when idle". */
export function idleHint(lifecycle: LifecycleChoice): string {
  return lifecycle === 'eager'
    ? 'Stays loaded, so the first decision is fast, and holds its memory all the time.'
    : 'Frees its memory or the NPU when no decision has come for that long. It loads again on the next decision.';
}
