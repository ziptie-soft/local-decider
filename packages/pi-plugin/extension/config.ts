/**
 * Extension configuration. The environment is passed in (never read from `process.env` here).
 *
 * The token pairs with the URL: it is `LOCAL_DECIDER_TOKEN` and is only used with the default
 * gateway URL or `LOCAL_DECIDER_URL`. Warnings never contain the token.
 */

export type GateMode = 'off' | 'guard' | 'approve';

export interface Config {
  readonly mode: GateMode;
  readonly url: string;
  readonly token?: string;
  readonly guardTimeoutMs: number;
  readonly approveTimeoutMs: number;
  readonly dialogTimeoutMs: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_GUARD_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 10_000;

const MODES: readonly GateMode[] = ['off', 'guard', 'approve'];

/** A mode name, or null when `value` is not one. */
export function parseMode(value: unknown): GateMode | null {
  if (typeof value !== 'string') {
    return null;
  }
  const v = value.trim().toLowerCase();
  return MODES.find((m) => m === v) ?? null;
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function resolveMode(env: Env, flag: unknown, warnings: string[]): GateMode {
  const flagSet = flag !== undefined && flag !== null && flag !== '';
  const raw: unknown = flagSet ? flag : nonEmpty(env['LOCAL_DECIDER_PI_MODE']);
  if (raw === undefined) {
    return 'guard';
  }
  const mode = parseMode(raw);
  if (mode === null) {
    const source = flagSet ? 'The mode flag' : 'LOCAL_DECIDER_PI_MODE';
    warnings.push(
      `${source} has an invalid value; local-decider is off (use off, guard or approve)`,
    );
    return 'off';
  }
  return mode;
}

function resolveGuardTimeout(env: Env, warnings: string[]): number {
  const raw = nonEmpty(env['LOCAL_DECIDER_TIMEOUT_MS']);
  if (raw === undefined) {
    return DEFAULT_GUARD_TIMEOUT_MS;
  }
  const n = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS) {
    return n;
  }
  warnings.push(
    `LOCAL_DECIDER_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMEOUT_MS}; using ${DEFAULT_GUARD_TIMEOUT_MS}`,
  );
  return DEFAULT_GUARD_TIMEOUT_MS;
}

export function resolveConfig(
  env: Env,
  flags: { mode?: unknown },
): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const mode = resolveMode(env, flags.mode, warnings);
  const guardTimeoutMs = resolveGuardTimeout(env, warnings);
  const token = nonEmpty(env['LOCAL_DECIDER_TOKEN']);
  const config: Config = {
    mode,
    url: nonEmpty(env['LOCAL_DECIDER_URL']) ?? DEFAULT_URL,
    ...(token === undefined ? {} : { token }),
    guardTimeoutMs,
    approveTimeoutMs: 10_000,
    dialogTimeoutMs: 120_000,
  };
  return { config, warnings };
}
