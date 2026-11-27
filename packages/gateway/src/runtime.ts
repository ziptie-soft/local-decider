import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

import { ConfigFile, MemoryConfigStore, type ConfigStore } from './config-file.ts';
import { isLoopback, type GatewayConfig } from './config.ts';
import { probeConnection } from './connection-probe.ts';
import { Decider } from './decider.ts';
import { EngineControl } from './engine-control.ts';
import type { Engine } from './engines/types.ts';
import type { LogStore } from './log-store.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs, type LoadedPolicy } from './policies.ts';
import { ensureControlToken, ensureReportToken } from './report-token.ts';
import { writeSchemas } from './schemas.ts';
import { createGatewayHandler, serverTimeouts, type ServerOptions } from './server.ts';
import { gatewaySocketPath } from './socket-path.ts';
import { openLogStore } from './sqlite-log.ts';
import { StatsService } from './stats-service.ts';
import { GATEWAY_VERSION } from './version.ts';

export interface Gateway {
  readonly server: Server;
  readonly socketServer?: Server;
  readonly decider: Decider;
  readonly url: string;
  /** Write queued log records now (the synchronous exit hook). */
  flushLog(): void;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Startup settings (host and port may carry command-line overrides). */
  readonly config: GatewayConfig;
  /** Where settings changes go; a `ConfigFile` is also watched. Default: in memory only. */
  readonly store?: ConfigStore;
  /** Diagnostics for settings reloads. */
  readonly log?: (line: string) => void;
  readonly paths: Paths;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected in tests; otherwise built from `config.engine` (and the saved selection). */
  readonly engine?: Engine;
  /** Injected in tests: a prepared engine control (with fakes). */
  readonly engineControl?: EngineControl;
  readonly policies?: ReadonlyMap<string, LoadedPolicy>;
  /** Injected storage; otherwise SQLite under the data directory. */
  readonly logStore?: LogStore;
}

/** Stats run in a worker when the log is the SQLite file; an injected store computes in-process. */
function statsService(options: StartOptions, log: LogStore): StatsService {
  return new StatsService({
    log,
    paths: options.logStore === undefined ? options.paths : undefined,
  });
}

/** A managed engine starts through EngineControl, which in auto mode lets the first reconcile pick it. */
function startEngine(engine: Engine, engineControl: EngineControl | undefined): void {
  if (engineControl !== undefined && engine === engineControl.engine) {
    engineControl.start();
  } else {
    void engine.start();
  }
}

/**
 * Listen first, then start the engine in the background: `/health` reports `degraded` while
 * the model loads, so adapters can skip decisions instead of waiting minutes.
 */
export async function startGateway(options: StartOptions): Promise<Gateway> {
  const state = prepareGateway(options);
  const listeners = await listenGatewayServers(
    state.log,
    state.config.host,
    state.config.port,
    gatewayServerOptions(state),
    state.socketPath,
  );
  return exposeGateway(state, listeners);
}

interface GatewayState {
  readonly config: GatewayConfig;
  readonly paths: Paths;
  readonly report: (line: string) => void;
  readonly store: ConfigStore;
  readonly engine: Engine;
  readonly engineControl: EngineControl | undefined;
  readonly log: LogStore;
  readonly decider: Decider;
  readonly stats: StatsService;
  readonly socketPath: string | null;
  readonly hasToken: boolean;
  readonly token: string | undefined;
  readonly reportToken: string;
  readonly instance: string;
}

function prepareGateway(options: StartOptions): GatewayState {
  const { config, paths } = options;
  const env = options.env ?? process.env;
  const report = options.log ?? NOOP;
  const token = env['LOCAL_DECIDER_TOKEN'];
  checkBinding(config.host, token);
  const hasToken = token !== undefined && token !== '';
  const store = options.store ?? new MemoryConfigStore(config);
  // An injected engine (tests) is not rebuilt from config, so it cannot be switched.
  const engineControl =
    options.engineControl ??
    (options.engine === undefined
      ? new EngineControl({ store, paths, env, pathsEditable: !hasToken })
      : undefined);
  const engine = options.engine ?? (engineControl as EngineControl).engine;
  const reportToken = ensureReportToken(paths);
  const policies = options.policies ?? loadPolicies(config, policyDirs(config, paths));
  const log = options.logStore ?? openLogStore(paths);
  const decider = new Decider({
    engine,
    policies,
    log,
    decisionTimeoutMs: config.decisionTimeoutMs,
  });
  decider.rebuildPrecedent();
  engineControl?.bind(decider);
  const stats = statsService(options, log);
  const instance = randomUUID();
  const socketPath = gatewaySocketPath(paths.run);
  reportSocketFallback(paths, socketPath, report);
  return {
    config,
    paths,
    report,
    store,
    engine,
    engineControl,
    log,
    decider,
    stats,
    socketPath,
    hasToken,
    token,
    reportToken,
    instance,
  };
}

function reportSocketFallback(
  paths: Paths,
  socketPath: string | null,
  report: (line: string) => void,
): void {
  if (socketPath === null && process.platform !== 'win32') {
    reportOnce(
      paths.run,
      report,
      `gateway socket path exceeds 100 bytes; using TCP at ${paths.run}`,
    );
  }
}

function gatewayServerOptions(state: GatewayState): ServerOptions {
  return {
    report: state.report,
    decider: state.decider,
    log: state.log,
    token: state.hasToken ? state.token : undefined,
    reportToken: state.reportToken,
    controlToken: ensureControlToken(state.paths),
    engineControl: state.engineControl,
    pricing: state.config.pricing,
    decisionTimeoutMs: state.config.decisionTimeoutMs,
    stats: state.stats,
    settings: () => state.engineControl?.settings ?? state.store.current,
    version: GATEWAY_VERSION,
    instance: state.instance,
  };
}

function exposeGateway(state: GatewayState, listeners: ListenerSet): Gateway {
  const { server, socketServer } = listeners;
  startEngine(state.engine, state.engineControl);
  const unwatch =
    state.store instanceof ConfigFile && state.engineControl !== undefined
      ? watchSettings(state.store, state.engineControl, state.report)
      : NOOP;
  const stopPruning = scheduleLogPruning(state.log, state.store, state.report);
  void pruneLogs(state.log, state.config.logs.retainDays, state.report);
  const { port } = server.address() as AddressInfo;
  const host = state.config.host.includes(':') ? `[${state.config.host}]` : state.config.host;
  return {
    server,
    decider: state.decider,
    url: `http://${host}:${String(port)}`,
    ...(socketServer === undefined ? {} : { socketServer }),
    flushLog: () => state.log.flush(),
    async close() {
      unwatch();
      stopPruning();
      await cancelBenchmark(state.engineControl);
      await state.engineControl?.idle();
      await state.decider.stopAll();
      state.stats.close();
      closeLogStore(state.log);
      server.closeAllConnections();
      socketServer?.closeAllConnections();
      await closeServer(server);
      if (socketServer !== undefined) {
        await closeServer(socketServer);
        removeOwnedSocket(listeners.socketPath, listeners.socketIdentity);
      }
    },
  };
}

const BENCHMARK_STOP_CAP_MS = 5000;

/** Ends a running benchmark before shutdown, waiting a little for it to let go of the engine. */
async function cancelBenchmark(engineControl: EngineControl | undefined): Promise<void> {
  const runner = engineControl?.benchmark;
  if (runner?.progress() == null) {
    return;
  }
  runner.cancel('shutdown');
  let timer: NodeJS.Timeout | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BENCHMARK_STOP_CAP_MS);
    timer.unref();
  });
  await Promise.race([runner.settled(), capped]);
  clearTimeout(timer);
}

async function pruneLogs(
  log: LogStore,
  retainDays: number,
  report: (line: string) => void,
): Promise<void> {
  try {
    await log.prune(retainDays);
  } catch (error) {
    report(`log retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleLogPruning(
  log: LogStore,
  store: ConfigStore,
  report: (line: string) => void,
): () => void {
  const interval = setInterval(
    () => void pruneLogs(log, store.current.logs.retainDays, report),
    24 * 60 * 60 * 1000,
  );
  interval.unref();
  return () => clearInterval(interval);
}

function closeLogStore(log: LogStore): void {
  log.close();
}

interface ListenerSet {
  readonly server: Server;
  readonly socketServer?: Server;
  readonly socketPath?: string;
  readonly socketIdentity?: { readonly dev: number; readonly ino: number };
}

async function listenGatewayServers(
  log: LogStore,
  host: string,
  port: number,
  options: ServerOptions,
  socketPath: string | null,
): Promise<ListenerSet> {
  const handler = createGatewayHandler(options);
  const timeouts = serverTimeouts(options.decisionTimeoutMs ?? 30_000);
  const server = createServer(timeouts, handler);
  let socketServer: Server | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    if (socketPath !== null) {
      socketServer = createServer(timeouts, handler);
      identity = await listenSocket(socketServer, socketPath);
    }
    return {
      server,
      ...(socketServer === undefined ? {} : { socketServer }),
      ...(socketPath === null || socketServer === undefined ? {} : { socketPath }),
      ...(identity === undefined ? {} : { socketIdentity: identity }),
    };
  } catch (error) {
    server.closeAllConnections();
    await closeServerIfListening(server);
    if (socketServer !== undefined) {
      socketServer.closeAllConnections();
      await closeServerIfListening(socketServer);
      removeOwnedSocket(socketPath ?? undefined, identity);
    }
    closeLogStore(log);
    throw error;
  }
}

async function closeServerIfListening(server: Server): Promise<void> {
  if (!server.listening) return;
  await closeServer(server);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function moveStaleSocket(path: string): Promise<boolean> {
  const displaced = join(dirname(path), `.gateway.sock.stale-${randomUUID()}`);
  try {
    renameSync(path, displaced);
  } catch {
    return false;
  }
  const state = await probeConnection({ path: displaced }, 400);
  if (state === 'refused') {
    unlinkSync(displaced);
    return true;
  }
  try {
    renameSync(displaced, path);
  } catch (error) {
    throw new Error(`could not restore the gateway socket at ${path}`, { cause: error });
  }
  return false;
}

async function listenSocket(
  server: Server,
  path: string,
): Promise<{ readonly dev: number; readonly ino: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      chmodSync(path, 0o600);
      const stat = lstatSync(path);
      const identity = { dev: stat.dev, ino: stat.ino };
      return identity;
    } catch (error) {
      if (
        attempt !== 0 ||
        (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' ||
        (await probeConnection({ path }, 400)) !== 'refused' ||
        !(await moveStaleSocket(path))
      )
        throw error;
    }
  }
  throw new Error(`could not listen on gateway socket ${path}`);
}

function removeOwnedSocket(
  path: string | undefined,
  identity: { readonly dev: number; readonly ino: number } | undefined,
): void {
  if (path === undefined || identity === undefined) return;
  const displaced = join(dirname(path), `.gateway.sock.close-${randomUUID()}`);
  try {
    renameSync(path, displaced);
  } catch {
    return;
  }
  try {
    const current = lstatSync(displaced);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(displaced);
      return;
    }
    renameSync(displaced, path);
  } catch {
    // The socket was replaced; leave the displaced entry in place rather than unlinking another owner.
  }
}

const reportedSocketPaths = new Set<string>();

function reportOnce(runDir: string, report: (line: string) => void, message: string): void {
  if (reportedSocketPaths.has(runDir)) return;
  reportedSocketPaths.add(runDir);
  report(message);
}

function NOOP(): void {}

function checkBinding(host: string, token: string | undefined): void {
  if (!isLoopback(host) && (token === undefined || token.length < 16)) {
    throw new Error(`binding ${host} needs LOCAL_DECIDER_TOKEN (>= 16 chars) in the environment`);
  }
}

/**
 * Write the JSON Schemas next to config.yaml, then apply edits of it and of policy files as they
 * happen; an invalid edit is reported, not applied.
 */
function watchSettings(
  store: ConfigFile,
  control: EngineControl,
  log: (line: string) => void,
): () => void {
  writeSchemas(join(dirname(store.file), 'schemas'));
  const fail = (error: unknown): void =>
    log(`settings not applied: ${error instanceof Error ? error.message : String(error)}`);
  return store.watch({
    onConfig: () => {
      try {
        store.reload();
      } catch (error) {
        fail(error);
        return;
      }
      // Diff-based: a no-op after our own write, and it also catches an outside edit that a
      // settings-page save already folded into the file.
      control.applyConfig().then((notes) => {
        notes.forEach(log);
      }, fail);
    },
    onPolicies: () => {
      try {
        log(`reloaded policies: ${control.reloadPolicies().join(', ')}`);
      } catch (error) {
        fail(error);
      }
    },
  });
}
