import { spawn } from 'node:child_process';
import { fchmodSync, openSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { GatewayConfig } from './config.ts';
import {
  acquireOwnerLock,
  OwnerLockBusyError,
  releaseOwnerLock,
  type OwnerLock,
} from './owner-lock.ts';
import type { Paths } from './paths.ts';
import { ensurePrivatePaths } from './private-paths.ts';
import {
  clearGatewayStopped,
  detectManager,
  gatewayWasStopped,
  installedService,
  startInstalledService,
  type ServiceManager,
} from './service.ts';

export type EnsureListener =
  | 'running'
  | 'started'
  | 'service-started'
  | 'remote'
  | 'port-busy'
  | 'mismatch'
  | 'stopped'
  | 'unsafe-path'
  | 'failed';

export interface EnsureResult {
  readonly listener: EnsureListener;
  readonly engine: {
    readonly status: string;
    readonly engineState: string | null;
    readonly detail: string | null;
  } | null;
  readonly message: string;
}

export interface EnsureDeps {
  readonly fetch?: typeof fetch;
  readonly spawn?: typeof spawn;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly portOpen?: (url: URL) => Promise<boolean>;
  readonly installed?: (manager: ServiceManager) => boolean;
  readonly startService?: (manager: Exclude<ServiceManager, 'pidfile'>) => void;
  readonly manager?: ServiceManager;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly script?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface Probe {
  readonly health: Record<string, unknown> | null;
}

type StartupFailure =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null };

type StartupResult =
  | { readonly kind: 'health'; readonly health: Record<string, unknown> | null }
  | { readonly kind: 'failure'; readonly failure: StartupFailure };

function engineFrom(health: Record<string, unknown> | null): EnsureResult['engine'] {
  if (health === null) return null;
  return {
    status: typeof health['status'] === 'string' ? health['status'] : 'unknown',
    engineState: typeof health['engineState'] === 'string' ? health['engineState'] : null,
    detail: typeof health['detail'] === 'string' ? health['detail'] : null,
  };
}

async function probe(url: URL, fetcher: typeof fetch, signal?: AbortSignal): Promise<Probe> {
  try {
    const response = await fetcher(new URL('/health', url), {
      method: 'GET',
      redirect: 'error',
      signal:
        signal === undefined
          ? AbortSignal.timeout(1000)
          : AbortSignal.any([AbortSignal.timeout(1000), signal]),
    });
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null) return { health: null };
    const health = value as Record<string, unknown>;
    return typeof health['status'] === 'string' ? { health } : { health: null };
  } catch {
    return { health: null };
  }
}

export function configuredGatewayUrl(config: GatewayConfig, override?: string): string {
  if (override !== undefined) return override;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const formattedHost = host.includes(':') ? `[${host}]` : host;
  return `http://${formattedHost}:${String(config.port)}`;
}

function sameEndpoint(requested: URL, configured: URL): boolean {
  return (
    requested.protocol === configured.protocol &&
    normalizeHost(requested.hostname) === normalizeHost(configured.hostname) &&
    effectivePort(requested) === effectivePort(configured)
  );
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function result(
  listener: EnsureListener,
  message: string,
  health: Record<string, unknown> | null = null,
): EnsureResult {
  return { listener, engine: engineFrom(health), message };
}

async function isPortOpen(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: normalizeHost(url.hostname),
      port: Number(effectivePort(url)),
    });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function childArgs(deps: EnsureDeps): string[] {
  const conditions = (deps.execArgv ?? process.execArgv).filter(
    (arg) => arg === '--conditions=source',
  );
  return [...conditions, deps.script ?? process.argv[1] ?? '', 'gateway', 'run'];
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out['NODE_OPTIONS'];
  delete out['NODE_PATH'];
  return out;
}

function spawnGateway(paths: Paths, deps: EnsureDeps): Promise<StartupFailure> {
  const log = join(paths.logs, 'gateway.log');
  const fd = openSync(log, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    const child = (deps.spawn ?? spawn)(deps.execPath ?? process.execPath, childArgs(deps), {
      cwd: paths.run,
      detached: true,
      env: childEnv(deps.env ?? process.env),
      stdio: ['ignore', fd, fd],
    });
    const startupFailure = new Promise<StartupFailure>((resolve) => {
      child.once('error', (error) => resolve({ kind: 'error', message: error.message }));
      child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
    });
    child.unref();
    return startupFailure;
  } finally {
    closeSync(fd);
  }
}

async function waitForHealth(
  url: URL,
  timeoutMs: number,
  deps: EnsureDeps,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const end = (deps.now ?? Date.now)() + timeoutMs;
  while ((deps.now ?? Date.now)() < end) {
    const found = await probe(url, fetcher, signal);
    if (signal?.aborted) return null;
    if (found.health !== null) return found.health;
    await (deps.sleep ?? ((ms) => sleep(ms)))(
      Math.min(200, Math.max(1, end - (deps.now ?? Date.now)())),
    );
    if (signal?.aborted) return null;
  }
  return (await probe(url, fetcher, signal)).health;
}

async function waitForStartup(
  url: URL,
  timeoutMs: number,
  deps: EnsureDeps,
  startupFailure: Promise<StartupFailure>,
): Promise<StartupResult> {
  const controller = new AbortController();
  const health = waitForHealth(url, timeoutMs, deps, controller.signal).then((value) => ({
    kind: 'health' as const,
    health: value,
  }));
  const failure = startupFailure.then((value) => {
    controller.abort();
    return { kind: 'failure' as const, failure: value };
  });
  return Promise.race([health, failure]);
}

function startupFailureResult(paths: Paths, failure: StartupFailure): EnsureResult {
  if (failure.kind === 'error') return result('failed', failure.message);
  const status =
    failure.signal === null ? `code ${String(failure.code)}` : `signal ${failure.signal}`;
  return result(
    'failed',
    `gateway exited before /health answered (${status}); see ${join(paths.logs, 'gateway.log')}`,
  );
}

function safePaths(paths: Paths): EnsureResult | undefined {
  try {
    ensurePrivatePaths(paths, true);
    return undefined;
  } catch (error) {
    return result('unsafe-path', error instanceof Error ? error.message : String(error));
  }
}

function stopped(paths: Paths, force: boolean): EnsureResult | undefined {
  if (!gatewayWasStopped(paths)) return undefined;
  if (!force)
    return result('stopped', 'gateway stop was requested; run gateway start or use --force');
  clearGatewayStopped(paths);
  return undefined;
}

async function ensureLocked(
  url: URL,
  paths: Paths,
  timeoutMs: number,
  deps: EnsureDeps,
): Promise<EnsureResult> {
  let lock: OwnerLock | undefined;
  try {
    lock = acquireOwnerLock(join(paths.run, 'launch.lock'));
  } catch (error) {
    return await failedLockAcquire(url, timeoutMs, deps, error);
  }
  try {
    return await startWithLock(url, paths, timeoutMs, deps);
  } catch (error) {
    return result('failed', error instanceof Error ? error.message : String(error));
  } finally {
    releaseOwnerLock(lock);
  }
}

async function failedLockAcquire(
  url: URL,
  timeoutMs: number,
  deps: EnsureDeps,
  error: unknown,
): Promise<EnsureResult> {
  if (!(error instanceof OwnerLockBusyError))
    return result('failed', error instanceof Error ? error.message : String(error));
  const health = await waitForHealth(url, timeoutMs, deps);
  if (health !== null)
    return result('running', 'gateway became ready while another launcher held the lock', health);
  if (await (deps.portOpen ?? isPortOpen)(url))
    return result('port-busy', 'the configured port is open but /health did not answer');
  return result(
    'failed',
    'another launcher held the start lock, but the gateway did not become ready',
  );
}

async function startWithLock(
  url: URL,
  paths: Paths,
  timeoutMs: number,
  deps: EnsureDeps,
): Promise<EnsureResult> {
  const before = await probe(url, deps.fetch ?? globalThis.fetch);
  if (before.health !== null)
    return result('running', 'gateway is already answering /health', before.health);
  if (await (deps.portOpen ?? isPortOpen)(url))
    return result('port-busy', 'the configured port is open but /health did not answer');
  const startup = await waitForStartup(url, timeoutMs, deps, spawnGateway(paths, deps));
  if (startup.kind === 'failure') return startupFailureResult(paths, startup.failure);
  const health = startup.health;
  if (health !== null) return result('started', 'gateway started and is answering /health', health);
  if (await (deps.portOpen ?? isPortOpen)(url))
    return result('port-busy', 'the configured port is open but /health did not answer');
  return result('failed', 'gateway did not answer /health before the timeout');
}

type EndpointResult = { readonly url: URL } | { readonly error: EnsureResult };

function localEndpoint(config: GatewayConfig, requested?: string): EndpointResult {
  let url: URL;
  try {
    url = new URL(requested ?? configuredGatewayUrl(config));
  } catch {
    return { error: result('failed', 'invalid gateway URL') };
  }
  if (!isLoopbackHost(url.hostname))
    return { error: result('remote', 'refusing to launch for a remote URL') };
  if (!sameEndpoint(url, new URL(configuredGatewayUrl(config)))) {
    return {
      error: result('mismatch', 'URL does not match the configured gateway bind address and port'),
    };
  }
  return { url };
}

async function ensureAtEndpoint(
  url: URL,
  paths: Paths,
  timeoutMs: number,
  deps: EnsureDeps,
  force: boolean,
): Promise<EnsureResult> {
  const initial = await probe(url, deps.fetch ?? globalThis.fetch);
  if (initial.health !== null)
    return result('running', 'gateway is already answering /health', initial.health);
  const stopResult = stopped(paths, force);
  if (stopResult !== undefined) return stopResult;
  const manager = deps.manager ?? detectManager();
  const installed = (deps.installed ?? ((value) => installedService(value)))(manager);
  if (installed && manager !== 'pidfile')
    return startInstalledGateway(manager, url, paths, timeoutMs, deps);
  return ensureLocked(url, paths, timeoutMs, deps);
}

async function startInstalledGateway(
  manager: Exclude<ServiceManager, 'pidfile'>,
  url: URL,
  paths: Paths,
  timeoutMs: number,
  deps: EnsureDeps,
): Promise<EnsureResult> {
  clearGatewayStopped(paths);
  try {
    (deps.startService ?? ((value) => startInstalledService(value)))(manager);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return result('failed', `could not start the installed service: ${detail}`);
  }
  const health = await waitForHealth(url, timeoutMs, deps);
  if (health === null) {
    return result(
      'failed',
      'installed service did not answer /health before the timeout; try gateway status',
    );
  }
  return result('service-started', 'installed gateway service started', health);
}

/** Ensure one local gateway listener answers at its configured endpoint. */
export async function ensureGateway(options: {
  readonly paths: Paths;
  readonly config: GatewayConfig;
  readonly url?: string;
  readonly timeoutSeconds?: number;
  readonly force?: boolean;
  readonly deps?: EnsureDeps;
}): Promise<EnsureResult> {
  const { paths, config, deps = {} } = options;
  const endpoint = localEndpoint(config, options.url);
  if ('error' in endpoint) return endpoint.error;
  const safety = safePaths(paths);
  if (safety !== undefined) return safety;
  const timeoutMs = Math.max(0, (options.timeoutSeconds ?? 30) * 1000);
  return ensureAtEndpoint(endpoint.url, paths, timeoutMs, deps, options.force === true);
}

export function ensureExitCode(outcome: EnsureResult): number {
  if (
    outcome.listener === 'running' ||
    outcome.listener === 'started' ||
    outcome.listener === 'service-started'
  )
    return 0;
  if (
    outcome.listener === 'remote' ||
    outcome.listener === 'mismatch' ||
    outcome.listener === 'unsafe-path'
  )
    return 2;
  if (outcome.listener === 'port-busy') return 3;
  return 1;
}
