import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as timerSleep } from 'node:timers/promises';

import type { EngineCounters } from '../counters.ts';
import type { Paths } from '../paths.ts';
import { engineChildEnv } from './child-env.ts';
import { killChild, trackChild } from './child-reaper.ts';
import { getHealth, postSystemOne } from './http.ts';
import { createEngineLogFilter } from './log-filter.ts';
import { EngineError, type Engine, type EngineHealth, type EngineState } from './types.ts';

const MAX_RESTARTS = 5;
/** Healthy this long before exiting, and the next crash starts a new restart budget. */
const STABLE_MS = 5 * 60_000;
const MAX_ENGINE_LOG_BYTES = 10 * 1024 * 1024;
/** Restart backoff is `RESTART_BASE_MS * 2 ** n` for the n-th restart, capped. */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 60_000;
/** SIGTERM to SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** A failed engine is not relaunched by a decision sooner than this after it failed. */
const FAILED_RETRY_COOLDOWN_MS = 60_000;
const HEALTH_POLL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 3000;
/** Consecutive decision timeouts before `/health` is probed for a hang. */
const HANG_TIMEOUTS = 3;
const HANG_PROBE_TIMEOUT_MS = 3000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Test seam: every side effect of the supervisor. Production uses the defaults. */
export interface SupervisorDeps {
  readonly spawn?: typeof spawn;
  readonly freePort?: () => Promise<number>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

interface ResolvedDeps {
  readonly spawn: typeof spawn;
  readonly freePort: () => Promise<number>;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
}

function resolveDeps(deps: SupervisorDeps | undefined): ResolvedDeps {
  return {
    spawn: deps?.spawn ?? spawn,
    freePort: deps?.freePort ?? freePort,
    fetch: deps?.fetch ?? globalThis.fetch,
    sleep:
      deps?.sleep ??
      ((ms, signal) =>
        timerSleep(ms, undefined, { ref: false, ...(signal === undefined ? {} : { signal }) })),
    now: deps?.now ?? Date.now,
  };
}

/** How to launch and probe one kind of `/v1/systemone` server. */
export interface ServerSpec {
  readonly id: string;
  readonly model: string;
  /** Attach here instead of spawning. */
  readonly url?: string | undefined;
  readonly startTimeoutSeconds: number;
  /** Path probed for readiness; any 2xx JSON body counts. */
  readonly healthPath: string;
  /** Executable, or undefined with `missing` explaining why. */
  binary(): { readonly path?: string; readonly missing?: string };
  /** argv after the binary. Every element comes from validated config, never from a request. */
  args(port: number): string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Device the last launch resolved, for health. */
  deviceInfo?(): {
    readonly requested: string;
    readonly resolved: string | undefined;
    readonly backend: string | undefined;
  };
  /** Requests the server answers at once (its `--max-concurrency`); unset = one. */
  readonly concurrency?: number | undefined;
  /** Context window from the readiness body, when the server reports one. */
  maxLength?(body: Record<string, unknown>): number | undefined;
}

/** Child output worth a remedy: the strands engine started on a CUDA device with CPU-only torch. */
const OUTPUT_HINTS: readonly { readonly match: string; readonly hint: string }[] = [
  {
    match: 'Torch not compiled with CUDA enabled',
    hint: 'torch has no CUDA support: set the device to cpu, or run local-decider engine install --flavor cuda (or rocm)',
  },
];
const OUTPUT_TAIL_CHARS = 4096;

function outputHint(tail: string): string | undefined {
  return OUTPUT_HINTS.find((entry) => tail.includes(entry.match))?.hint;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `/v1/systemone` server spawned on a free loopback port and supervised with restart backoff
 * (or attached to `spec.url`). Output goes to `logs/engine-<id>.log`.
 *
 * `#gen` is bumped by `stop()`, `#fail` and every launch. Exit and error handlers, health-poll
 * iterations and backoff timers each capture it and return when it moved on, so a stale one
 * never touches the current attempt.
 */
export class SupervisedEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly #spec: ServerSpec;
  readonly #paths: Paths;
  readonly #deps: ResolvedDeps;
  #url: string | undefined;
  #child: ChildProcess | undefined;
  #state: EngineState = 'stopped';
  #detail: string | undefined;
  /** The last bit of the child's output, for `outputHint`; reset per launch. */
  #outputTail = '';
  #hint: string | undefined;
  #maxLength: number | undefined;
  #restarts = 0;
  /** When the engine last became ready; a long healthy run resets the restart budget. */
  #readyAt: number | undefined;
  #failedAt: number | undefined;
  #gen = 0;
  /** The attempt or scheduled restart in flight; `start()` joins it. */
  #starting: Promise<void> | undefined;
  #backoff: AbortController | undefined;
  /** Consecutive decision deadline expiries; any answer resets it. */
  #timeouts = 0;
  #probing = false;
  /** Lifetime totals for `/health`; unlike `#restarts` they never reset. */
  #totalRestarts = 0;
  #totalHangs = 0;

  constructor(spec: ServerSpec, paths: Paths, deps?: SupervisorDeps) {
    this.#spec = spec;
    this.#paths = paths;
    this.#deps = resolveDeps(deps);
    this.id = spec.id;
    this.model = spec.model;
    this.#url = spec.url;
  }

  get concurrency(): number | undefined {
    return this.#spec.concurrency;
  }

  /** Idempotent and never rejects; failures end in `failed` with a detail. */
  start(): Promise<void> {
    if (this.#starting !== undefined) {
      return this.#starting;
    }
    if (this.#state === 'ready' || this.#inCooldown()) {
      return Promise.resolve();
    }
    return this.#track(this.#attempt());
  }

  counters(): EngineCounters {
    return { engineRestarts: this.#totalRestarts, engineHangs: this.#totalHangs };
  }

  health(): EngineHealth {
    const device = this.#spec.deviceInfo?.();
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
      ...(this.#maxLength === undefined ? {} : { maxLength: this.#maxLength }),
      ...(device === undefined ? {} : { requestedDevice: device.requested }),
      ...(device?.resolved === undefined ? {} : { resolvedDevice: device.resolved }),
      ...(device?.backend === undefined ? {} : { backend: device.backend }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    if (this.#state !== 'ready' || this.#url === undefined) {
      throw new EngineError(
        `engine ${this.#state}${this.#hint === undefined ? '' : ` (${this.#hint})`}`,
      );
    }
    try {
      const answer = await postSystemOne(
        { baseUrl: this.#url, fetch: this.#deps.fetch },
        request,
        signal,
      );
      this.#timeouts = 0;
      return answer;
    } catch (error) {
      // Only the decision deadline counts; a caller abort, busy 503 or HTTP error is neutral.
      if (
        signal.aborted &&
        (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
      ) {
        this.#noteTimeout();
      }
      throw error;
    }
  }

  /** Counts consecutive decision timeouts; at the threshold, probes `/health` once at a time. */
  #noteTimeout(): void {
    this.#timeouts += 1;
    if (this.#timeouts < HANG_TIMEOUTS || this.#probing) {
      return;
    }
    this.#probing = true;
    void this.#probeHang(this.#gen).finally(() => {
      this.#probing = false;
    });
  }

  async #probeHang(gen: number): Promise<void> {
    const url = this.#url;
    if (url === undefined) {
      return;
    }
    const count = this.#timeouts;
    const body = await getHealth(
      url,
      HANG_PROBE_TIMEOUT_MS,
      this.#spec.healthPath,
      this.#deps.fetch,
    );
    if (gen !== this.#gen || this.#state !== 'ready') {
      return; // stopped, failed or restarted meanwhile: the verdict is stale
    }
    if (body !== null) {
      this.#timeouts = 0;
      this.#detail = `slow: ${String(count)} consecutive decision timeouts`;
      return;
    }
    this.#timeouts = 0;
    this.#totalHangs += 1;
    this.#state = 'starting';
    this.#detail = `engine hung (${String(count)} decision timeouts, no /health); restarting`;
    if (this.#spec.url !== undefined) {
      this.#totalRestarts += 1;
      void this.#track(this.#attempt()); // attached: nothing to kill, wait for it again
      return;
    }
    // The child's exit takes the normal #onExit path: backoff and the crash budget.
    void this.#terminate(this.#child);
  }

  async stop(): Promise<void> {
    this.#gen += 1;
    this.#cancelBackoff();
    this.#starting = undefined;
    this.#state = 'stopped';
    this.#restarts = 0;
    this.#readyAt = undefined;
    const child = this.#child;
    this.#child = undefined;
    await this.#terminate(child);
  }

  #inCooldown(): boolean {
    return (
      this.#state === 'failed' &&
      this.#failedAt !== undefined &&
      this.#deps.now() - this.#failedAt < FAILED_RETRY_COOLDOWN_MS
    );
  }

  #track(promise: Promise<void>): Promise<void> {
    const tracked: Promise<void> = promise.finally(() => {
      if (this.#starting === tracked) {
        this.#starting = undefined;
      }
    });
    this.#starting = tracked;
    return tracked;
  }

  #cancelBackoff(): void {
    this.#backoff?.abort();
    this.#backoff = undefined;
  }

  /** One launch (or attach) plus the wait for health. Never rejects. */
  async #attempt(): Promise<void> {
    this.#gen += 1;
    const gen = this.#gen;
    this.#cancelBackoff();
    const stale = this.#child;
    this.#child = undefined;
    void this.#terminate(stale);
    this.#state = 'starting';
    try {
      if (this.#spec.url === undefined && !(await this.#spawn(gen))) {
        return;
      }
      await this.#waitHealthy(gen);
    } catch (error) {
      if (gen === this.#gen) {
        this.#fail(`engine failed to start: ${errorMessage(error)}`);
      }
    }
  }

  /** Whether the launch went ahead; false when it failed or was superseded. */
  async #spawn(gen: number): Promise<boolean> {
    const binary = this.#spec.binary();
    if (binary.path === undefined || !existsSync(binary.path)) {
      this.#fail(binary.missing ?? `${String(binary.path)} not found`);
      return false;
    }
    const port = await this.#deps.freePort();
    if (gen !== this.#gen) {
      return false;
    }
    this.#url = `http://127.0.0.1:${String(port)}`;
    mkdirSync(this.#paths.logs, { recursive: true });
    const logPath = join(this.#paths.logs, `engine-${this.id}.log`);
    rotateEngineLog(logPath);
    const log = createWriteStream(logPath, { flags: 'a' });
    let child: ChildProcess;
    try {
      child = this.#deps.spawn(binary.path, this.#spec.args(port), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: engineChildEnv(process.env, this.#spec.env),
        // Its own process group, so stop and the exit hook reach any grandchildren too.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      log.destroy();
      throw error;
    }
    this.#outputTail = '';
    this.#hint = undefined;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer | string) => this.#noteOutput(String(chunk)));
      stream?.pipe(createEngineLogFilter()).pipe(log, { end: false });
    }
    child.once('exit', (code, signal) => {
      log.end();
      this.#onExit(child, gen, code, signal);
    });
    // ENOENT or EACCES: no 'exit' follows, so fail here instead of crashing on an unhandled event.
    child.once('error', (error) => {
      log.end();
      this.#onSpawnError(child, gen, error);
    });
    trackChild(child);
    this.#child = child;
    return true;
  }

  #noteOutput(chunk: string): void {
    this.#outputTail = (this.#outputTail + chunk).slice(-OUTPUT_TAIL_CHARS);
    this.#hint = outputHint(this.#outputTail) ?? this.#hint;
  }

  #onSpawnError(child: ChildProcess, gen: number, error: Error): void {
    if (gen !== this.#gen || this.#child !== child) {
      return;
    }
    this.#readyAt = undefined;
    this.#fail(`engine failed to start: ${error.message}`);
  }

  #onExit(
    child: ChildProcess,
    gen: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (gen !== this.#gen || this.#child !== child) {
      return; // stopped, failed or replaced: this exit is an orphan's
    }
    this.#child = undefined;
    const exited = `engine exited (${signal ?? `code ${String(code)}`})`;
    const reason = this.#hint === undefined ? exited : `${exited}: ${this.#hint}`;
    // A crash after a long healthy run is a fresh failure, not part of a crash loop.
    if (this.#readyAt !== undefined && this.#deps.now() - this.#readyAt >= STABLE_MS) {
      this.#restarts = 0;
    }
    this.#readyAt = undefined;
    if (this.#restarts >= MAX_RESTARTS) {
      this.#fail(`${reason}; giving up after ${String(MAX_RESTARTS)} restarts`);
      return;
    }
    this.#restarts += 1;
    this.#totalRestarts += 1;
    this.#state = 'starting';
    this.#detail = `${reason}; restart ${String(this.#restarts)}`;
    this.#scheduleRestart(Math.min(RESTART_BASE_MS * 2 ** this.#restarts, RESTART_MAX_MS));
  }

  #scheduleRestart(delayMs: number): void {
    const gen = this.#gen;
    const controller = new AbortController();
    this.#backoff = controller;
    const restart = this.#deps
      .sleep(delayMs, controller.signal)
      .then(() => (gen === this.#gen ? this.#attempt() : undefined))
      .catch((error: unknown) => {
        if (gen === this.#gen) {
          this.#fail(`engine restart failed: ${errorMessage(error)}`);
        }
      });
    void this.#track(restart);
  }

  async #waitHealthy(gen: number): Promise<void> {
    const deadline = this.#deps.now() + this.#spec.startTimeoutSeconds * 1000;
    while (gen === this.#gen && this.#deps.now() < deadline) {
      const url = this.#url;
      const body =
        url === undefined
          ? null
          : await getHealth(url, HEALTH_PROBE_TIMEOUT_MS, this.#spec.healthPath, this.#deps.fetch);
      if (gen !== this.#gen) {
        return;
      }
      if (body !== null) {
        this.#ready(body);
        return;
      }
      if (this.#spec.url === undefined && this.#child === undefined) {
        return; // exited; #onExit owns the next step
      }
      await this.#deps.sleep(HEALTH_POLL_MS);
    }
    if (gen === this.#gen && this.#state === 'starting') {
      this.#fail('engine did not become healthy in time');
    }
  }

  #ready(body: Record<string, unknown>): void {
    this.#state = 'ready';
    this.#timeouts = 0;
    this.#readyAt = this.#deps.now();
    this.#detail = undefined;
    this.#hint = undefined;
    this.#maxLength = this.#spec.maxLength?.(body);
  }

  /** Marks the engine failed and kills its child; a pending restart or health wait is dropped. */
  #fail(detail: string): void {
    this.#gen += 1;
    this.#cancelBackoff();
    this.#state = 'failed';
    this.#detail = detail;
    this.#failedAt = this.#deps.now();
    const child = this.#child;
    this.#child = undefined;
    void this.#terminate(child);
  }

  /** SIGTERM, then SIGKILL after the grace; resolves once the child exited or was killed. */
  async #terminate(child: ChildProcess | undefined): Promise<void> {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const timer = new AbortController();
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        timer.abort();
        resolve();
      });
    });
    killChild(child, 'SIGTERM');
    const killed = this.#deps
      .sleep(STOP_GRACE_MS, timer.signal)
      .then(() => killChild(child, 'SIGKILL'))
      .catch(() => undefined);
    await Promise.race([exited, killed]);
  }
}

function rotateEngineLog(path: string): void {
  if (!existsSync(path) || statSync(path).size <= MAX_ENGINE_LOG_BYTES) {
    return;
  }
  const previous = `${path}.1`;
  rmSync(previous, { force: true });
  renameSync(path, previous);
}
