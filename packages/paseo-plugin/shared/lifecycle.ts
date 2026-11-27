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

/** The engine states in the words Status and the Models card both use. */
const STATE_WORDS = {
  ready: 'Loaded',
  starting: 'Loading',
  stopped: 'Not loaded',
  failed: 'Failed',
} as const;

const STATE_TONES = {
  ready: 'success',
  starting: 'info',
  stopped: 'info',
  failed: 'error',
} as const;

/** The badge for an engine state (`Loaded`, `Not loaded`, `Loading`, `Failed`); null when unknown. */
export function stateBadge(
  state: string | null,
): { readonly text: string; readonly tone: 'success' | 'error' | 'info' } | null {
  return state !== null && state in STATE_WORDS
    ? {
        text: STATE_WORDS[state as keyof typeof STATE_WORDS],
        tone: STATE_TONES[state as keyof typeof STATE_TONES],
      }
    : null;
}

function loadedNote(s: EngineStateLike): string {
  const parts: string[] = [STATE_WORDS.ready];
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
      return `${STATE_WORDS.ready}.`;
    case 'starting':
      return `${STATE_WORDS.starting}…`;
    case 'failed': {
      const detail = s?.detail ?? 'no detail from the gateway';
      return `${STATE_WORDS.failed}: ${detail}${detail.endsWith('.') ? '' : '.'}`;
    }
    case 'stopped':
      return s?.lifecycle === 'eager'
        ? `${STATE_WORDS.stopped}; press Load now.`
        : `${STATE_WORDS.stopped}; loads on the next decision.`;
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

/** The select value of "Custom…": it reveals a minutes field instead of setting anything. */
export const CUSTOM_IDLE = 'custom';

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

/** The idle times the gateway accepts: whole minutes from 1 to 1440 (a day). */
export function clampIdleMinutes(minutes: number): number {
  return Math.min(IDLE_MINUTES.max, Math.max(IDLE_MINUTES.min, Math.round(minutes)));
}

function idleLabel(minutes: number): string {
  return PRESET_LABELS[minutes] ?? `After ${String(minutes)} min`;
}

/**
 * The "Unload when idle" options: the presets, plus the current idle time in numeric order when
 * it is none of them (so the current value is always selectable), then "Never (stay loaded)".
 */
export function idleOptions(lifecycle: LifecycleChoice, minutes: number | null): IdleOption[] {
  const current = lifecycle === 'lazy' ? clampIdleMinutes(minutes ?? IDLE_MINUTES.fallback) : null;
  const all = new Set<number>(IDLE_PRESETS);
  if (current !== null) {
    all.add(current);
  }
  return [
    ...[...all].toSorted((a, b) => a - b).map((m) => ({ label: idleLabel(m), value: String(m) })),
    { label: 'Never (stay loaded)', value: NEVER },
    { label: 'Custom…', value: CUSTOM_IDLE },
  ];
}

/** The minutes typed into the custom field, clamped to 1–1440; null when it is not a number. */
export function parseIdleMinutes(text: string): number | null {
  const trimmed = text.trim();
  const minutes = trimmed === '' ? Number.NaN : Number(trimmed);
  return Number.isFinite(minutes) ? clampIdleMinutes(minutes) : null;
}

/** The select value for the engine's lifecycle and idle minutes. */
export function idleValue(lifecycle: LifecycleChoice, minutes: number | null): string {
  return lifecycle === 'eager' ? NEVER : String(clampIdleMinutes(minutes ?? IDLE_MINUTES.fallback));
}

/** The lifecycle a select value stands for; `Never` is eager. */
export function parseIdleValue(value: string): IdleChoice {
  const minutes = Number(value);
  if (value === NEVER) {
    return { lifecycle: 'eager' };
  }
  return {
    lifecycle: 'lazy',
    idleUnloadMinutes: Number.isFinite(minutes) ? clampIdleMinutes(minutes) : IDLE_MINUTES.fallback,
  };
}

/** The hint under "Unload when idle". */
export function idleHint(lifecycle: LifecycleChoice): string {
  return lifecycle === 'eager'
    ? 'Stays loaded, so the first decision is fast, and holds its memory all the time.'
    : 'Frees its memory or the NPU when no decision has come for that long. It loads again on the next decision.';
}
