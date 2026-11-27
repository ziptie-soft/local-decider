/**
 * pi extension entry point. Registration does no I/O. The config is resolved from the environment
 * and the mode flag at `session_start` (or lazily on first use), the gateway and gate are rebuilt
 * per session, and a `/local-decider` command shows the state and sets a session mode override.
 */

import { readFileSync } from 'node:fs';

import { registerClassifier } from './classifier.ts';
import { resolveConfig, parseMode, type Config, type Env, type GateMode } from './config.ts';
import { createGate, type Gate } from './gate.ts';
import { createGateway, type CallOptions, type Gateway } from './gateway.ts';
import { launchGateway, type LaunchResult } from './launcher/launch.ts';
import type { PiAPI, PiContext } from './pi-types.ts';

export const FLAG_NAME = 'local-decider-mode';
const COMMAND_NAME = 'local-decider';
export const STATUS_KEY = 'local-decider';
const HEALTH_TIMEOUT_MS = 1500;
const GUIDE_URL_BASE = 'https://github.com/ziptie-soft/local-decider/blob/master/docs/';
export const PI_GUIDE_URL = `${GUIDE_URL_BASE}install-pi.ai.md`;

const USAGE = 'local-decider: usage: /local-decider [start|mode <off|guard|approve>]';

export interface ExtensionOptions {
  readonly env?: Env;
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly launch?: typeof launchGateway;
}

type Health = 'ok' | 'degraded' | 'down' | 'offline' | 'unknown';

interface Resolved {
  readonly config: Config;
  readonly warnings: readonly string[];
}

/** UI calls never throw out of a handler (pi's `ui` may be absent or a no-op without a UI). */
function safeNotify(ctx: PiContext, message: string, level?: 'info' | 'warning' | 'error'): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // ignored
  }
}

function safeStatus(ctx: PiContext, text: string): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // ignored
  }
}

function readFlag(pi: PiAPI): unknown {
  try {
    return pi.getFlag(FLAG_NAME);
  } catch {
    return undefined;
  }
}

function statusText(mode: GateMode, health: Health): string {
  if (mode === 'off') return `ld: ${mode}`;
  if (health === 'offline') return 'ld: offline';
  if (health === 'down') return 'ld: down';
  return `ld: ${mode}`;
}

/** Per-activation mutable state, reset on `session_shutdown`. */
function createState(pi: PiAPI, opts: ExtensionOptions): State {
  const env: Env = opts.env ?? process.env;
  let resolved: Resolved | null = null;
  let override: GateMode | null = null;
  let gateway: Gateway | null = null;
  let gate: Gate | null = null;
  let health: Health = 'unknown';
  let setupGuideShown = false;
  let lastDecision: string | undefined;
  let epoch = 0;

  const getResolved = (): Resolved => {
    resolved ??= resolveConfig(env, { mode: readFlag(pi) });
    return resolved;
  };
  const getConfig = (): Config => {
    const { config } = getResolved();
    return override === null ? config : { ...config, mode: override };
  };
  const getGateway = (): Gateway => {
    gateway ??= createGateway({
      url: getResolved().config.url,
      clientId: `pi/${piVersion()}`,
      defaultEndpoint: getResolved().config.defaultEndpoint === true,
      env: { ...(opts.env ?? process.env) },
      token: getResolved().config.token,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    });
    return gateway;
  };
  const getGate = (): Gate => {
    gate ??= createGate({
      getConfig,
      gateway: getGateway(),
      now: opts.now ?? Date.now,
      log: () => {},
      platform: opts.platform ?? process.platform,
      onDecision: (id) => {
        lastDecision = id;
      },
    });
    return gate;
  };

  return {
    getConfig,
    getGateway,
    getGate,
    warnings: (): readonly string[] => getResolved().warnings,
    setOverride: (mode: GateMode): void => {
      override = mode;
    },
    health: (): Health => health,
    setHealth: (value: Health): void => {
      health = value;
    },
    guideShown: (): boolean => setupGuideShown,
    markGuideShown: (): void => {
      setupGuideShown = true;
    },
    lastDecision: (): string | undefined => lastDecision,
    nextEpoch: (): number => ++epoch,
    isCurrent: (n: number): boolean => n === epoch,
    /** Forget the session: override, config, gateway, gate (breaker) and caches. */
    reset: (): void => {
      epoch++;
      resolved = null;
      override = null;
      gateway = null;
      gate = null;
      health = 'unknown';
      setupGuideShown = false;
      lastDecision = undefined;
    },
  };
}

interface State {
  getConfig(): Config;
  getGateway(): Gateway;
  getGate(): Gate;
  warnings(): readonly string[];
  setOverride(mode: GateMode): void;
  health(): Health;
  setHealth(value: Health): void;
  guideShown(): boolean;
  markGuideShown(): void;
  lastDecision(): string | undefined;
  nextEpoch(): number;
  isCurrent(n: number): boolean;
  reset(): void;
}

/** A `Gateway` that always delegates to the state's current gateway. */
function gatewayProxy(state: State): Gateway {
  const call = <T>(f: (g: Gateway) => Promise<T>, fallback: T): Promise<T> => {
    try {
      return f(state.getGateway());
    } catch {
      return Promise.resolve(fallback);
    }
  };
  return {
    decide: (policy, request, options) => call((g) => g.decide(policy, request, options), null),
    reportOutcome: (id, outcome, options) =>
      call((g) => g.reportOutcome(id, outcome, options), false),
    health: (options: CallOptions) => call((g) => g.health(options), false),
    healthStatus: (options: CallOptions) =>
      call((g) => g.healthStatus?.(options) ?? Promise.resolve(null), null),
    systemOne: (body, options) => call((g) => g.systemOne(body, options), null),
  };
}

function readManifest(): Record<string, unknown> | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pinnedVersion(): string | null {
  const config = readManifest()?.['localDecider'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const version = (config as Record<string, unknown>)['gateway'];
  return typeof version === 'string' ? version : null;
}

function piVersion(): string {
  const version = readManifest()?.['version'];
  return typeof version === 'string' ? version : '0.0.0';
}

async function runLaunch(state: State, opts: ExtensionOptions): Promise<LaunchResult> {
  const version = pinnedVersion();
  if (version === null) {
    return {
      ok: false,
      status: 'not-installed',
      message: 'could not read the pinned gateway version',
    };
  }
  return (opts.launch ?? launchGateway)({
    url: state.getConfig().url,
    clientId: `pi/${piVersion()}`,
    defaultEndpoint: resolveConfig(opts.env ?? process.env, {}).config.defaultEndpoint === true,
    env: { ...(opts.env ?? process.env) },
    pinnedVersion: version,
    guideUrl: PI_GUIDE_URL,
    ...(opts.fetch === undefined ? {} : { deps: { fetch: opts.fetch } }),
  });
}

function healthValue(status: string | null | undefined): Health {
  if (status === null || status === undefined) return 'offline';
  if (status === 'down') return 'down';
  if (status === 'degraded') return 'degraded';
  return 'ok';
}

function notifySetupGuide(
  state: State,
  ctx: PiContext,
  health: Health,
  result?: LaunchResult,
): void {
  if ((health !== 'offline' && health !== 'down') || state.guideShown()) return;
  const reason =
    result !== undefined && !result.ok ? result.message.slice(0, 200) : `gateway is ${health}`;
  safeNotify(ctx, `local-decider: ${reason}. Setup guide: ${PI_GUIDE_URL}`, 'warning');
  state.markGuideShown();
}

async function refreshAfterLaunch(
  state: State,
  ctx: PiContext,
  epoch: number,
  result?: LaunchResult,
): Promise<void> {
  const status = await state
    .getGateway()
    .healthStatus?.({ timeoutMs: HEALTH_TIMEOUT_MS })
    .catch(() => null);
  if (!state.isCurrent(epoch)) return;
  const health = healthValue(status);
  state.setHealth(health);
  safeStatus(ctx, statusText(state.getConfig().mode, health));
  notifySetupGuide(state, ctx, health, result);
}

function launchAfterFailure(
  state: State,
  ctx: PiContext,
  opts: ExtensionOptions,
  epoch: number,
  launchOnce: { value: boolean },
): void {
  if (launchOnce.value) {
    const health = state.health();
    safeStatus(ctx, statusText(state.getConfig().mode, health));
    notifySetupGuide(state, ctx, health);
    return;
  }
  launchOnce.value = true;
  safeStatus(ctx, 'ld: starting');
  void runLaunch(state, opts)
    .then(
      (result) => refreshAfterLaunch(state, ctx, epoch, result),
      () => refreshAfterLaunch(state, ctx, epoch),
    )
    .catch(() => {
      state.setHealth('offline');
      safeStatus(ctx, 'ld: offline');
      notifySetupGuide(state, ctx, 'offline');
    });
}

function startHealthCheck(
  state: State,
  ctx: PiContext,
  opts: ExtensionOptions,
  launchOnce: { value: boolean },
): void {
  const epoch = state.nextEpoch();
  try {
    void Promise.resolve(state.getGateway().healthStatus?.({ timeoutMs: HEALTH_TIMEOUT_MS }))
      .then((status) => {
        if (!state.isCurrent(epoch)) return;
        const health = healthValue(status);
        state.setHealth(health);
        if (health === 'offline' || health === 'down') {
          launchAfterFailure(state, ctx, opts, epoch, launchOnce);
        }
      })
      .catch(() => {
        if (!state.isCurrent(epoch)) return;
        state.setHealth('offline');
        launchAfterFailure(state, ctx, opts, epoch, launchOnce);
      });
  } catch {
    state.setHealth('offline');
    launchAfterFailure(state, ctx, opts, epoch, launchOnce);
  }
}

function onSessionStart(
  state: State,
  ctx: PiContext,
  opts: ExtensionOptions,
  launchOnce: { value: boolean },
): void {
  for (const warning of state.warnings()) safeNotify(ctx, `local-decider: ${warning}`, 'warning');
  safeStatus(ctx, statusText(state.getConfig().mode, 'unknown'));
  if (state.getConfig().mode !== 'off') startHealthCheck(state, ctx, opts, launchOnce);
}

function describe(state: State): string {
  const { mode, url } = state.getConfig();
  const health = state.health();
  return [
    `local-decider: mode ${mode}`,
    url,
    `gateway ${health}`,
    `last decision ${state.lastDecision() ?? 'none'}`,
    ...(health === 'offline' || health === 'down' ? [`setup guide ${PI_GUIDE_URL}`] : []),
  ].join(' · ');
}

function setMode(state: State, value: string, ctx: PiContext): void {
  const mode = parseMode(value);
  if (mode === null) {
    safeNotify(
      ctx,
      `local-decider: unknown mode "${value.slice(0, 40)}" (use off, guard or approve)`,
      'warning',
    );
    return;
  }
  state.setOverride(mode);
  safeStatus(ctx, statusText(mode, state.health()));
  safeNotify(ctx, `local-decider: mode ${mode} for this session`, 'info');
}

async function onCommand(
  state: State,
  args: string,
  ctx: PiContext,
  opts: ExtensionOptions,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    safeNotify(ctx, describe(state), 'info');
  } else if (parts[0]?.toLowerCase() === 'mode' && parts.length === 2) {
    setMode(state, parts[1] ?? '', ctx);
  } else if (parts[0]?.toLowerCase() === 'start' && parts.length === 1) {
    safeStatus(ctx, 'ld: starting');
    const result = await runLaunch(state, opts);
    safeNotify(ctx, `local-decider: ${result.message}`, result.ok ? 'info' : 'warning');
    await refreshAfterLaunch(state, ctx, state.nextEpoch(), result);
  } else {
    safeNotify(ctx, USAGE, 'info');
  }
}

/** Builds the pi extension factory; `opts` lets tests inject the environment, fetch and clock. */
export function createExtension(opts: ExtensionOptions = {}): (pi: PiAPI) => void {
  const launchOnce = { value: false };
  return (pi) => {
    const state = createState(pi, opts);
    pi.registerFlag(FLAG_NAME, {
      type: 'string',
      description: 'local-decider mode: off, guard or approve',
    });
    pi.on('tool_call', (event, ctx) => state.getGate()(event, ctx));
    pi.on('session_start', (_event, ctx) => {
      onSessionStart(state, ctx, opts, launchOnce);
    });
    pi.on('session_shutdown', () => {
      state.reset();
    });
    pi.registerCommand(COMMAND_NAME, {
      description:
        'Show local-decider state, start the gateway, or set the mode: /local-decider [start|mode <off|guard|approve>]',
      handler: (args, ctx) => onCommand(state, args, ctx, opts),
    });
    registerClassifier(pi, {
      gateway: gatewayProxy(state),
      url: resolveConfig(opts.env ?? process.env, {}).config.url,
    });
  };
}

export default createExtension();
