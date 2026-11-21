import {
  tokenAllowed,
  type SystemOneRequest,
  type SystemOneResponse,
} from '@ziptie-soft/local-decider-core';
import { z } from 'zod';

import { defineEngine } from './descriptor.ts';
import { displayUrl, getHealth, postSystemOne } from './http.ts';
import { isUnreachable, withTransientRetry, type RetrySleep } from './retry.ts';
import type { Engine, EngineHealth, EngineState } from './types.ts';

const remoteSchema = z.strictObject({
  type: z.literal('systemone-remote'),
  url: z.url(),
  model: z.string().default('remote'),
  /** Name of the environment variable holding a bearer token for the remote engine. */
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
});

export type RemoteEngineConfig = z.infer<typeof remoteSchema>;

export const remoteEngine = defineEngine({
  id: 'systemone-remote',
  label: 'SystemOne Remote',
  description: 'Attach to another /v1/systemone server',
  configSchema: remoteSchema,
  selectable: false,
  pinned: () => true,
  supports: () => ({ ok: true }),
  tag: () => 'Remote',
  devices: () => [],
  calibrated: true,
  models: [],
  create: (config, ctx) => new SystemOneRemoteEngine(config, ctx.env),
});

/** A failed remote is not probed again by `start()` sooner than this after its last probe. */
const REMOTE_RECHECK_MS = 5000;
const REMOTE_PROBE_TIMEOUT_MS = 2000;

/** Test seam; production uses the defaults. */
export interface RemoteDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: RetrySleep;
  readonly now?: () => number;
}

/** Any `/v1/systemone` server: another machine, laya-serve, the GLiClass example server. */
export class SystemOneRemoteEngine implements Engine {
  readonly id = 'systemone-remote';
  readonly model: string;
  readonly #url: string;
  readonly #token: string | undefined;
  #state: EngineState = 'stopped';
  #detail: string | undefined;
  #probedAt: number | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: RetrySleep | undefined;
  readonly #now: () => number;

  constructor(
    config: RemoteEngineConfig,
    env: NodeJS.ProcessEnv = process.env,
    deps: RemoteDeps = {},
  ) {
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#sleep = deps.sleep;
    this.#now = deps.now ?? Date.now;
    this.model = config.model;
    this.#url = config.url;
    // Like the gateway client: a token travels only over https or to this machine.
    this.#token =
      config.tokenEnv === undefined || !tokenAllowed(config.url) ? undefined : env[config.tokenEnv];
  }

  async start(): Promise<void> {
    if (this.#state === 'failed' && this.#recentlyProbed()) {
      return; // decisions fail open meanwhile; the next start() after the window probes again
    }
    this.#state = 'starting';
    const health = await getHealth(this.#url, 5000, '/health', this.#fetch);
    this.#probedAt = this.#now();
    this.#state = health === null ? 'failed' : 'ready';
    this.#detail = health === null ? `no /health at ${displayUrl(this.#url)}` : undefined;
  }

  #recentlyProbed(): boolean {
    return this.#probedAt !== undefined && this.#now() - this.#probedAt < REMOTE_RECHECK_MS;
  }

  health(): EngineHealth {
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    try {
      const response = await withTransientRetry(
        () =>
          postSystemOne(
            { baseUrl: this.#url, token: this.#token, fetch: this.#fetch },
            request,
            signal,
          ),
        signal,
        this.#sleep === undefined ? {} : { sleep: this.#sleep },
      );
      this.#state = 'ready';
      return response;
    } catch (error) {
      // Busy, HTTP errors and bad bodies do not flip the engine: it answered. Only a transport
      // failure that survived the retries, and a silent /health, does.
      if (!signal.aborted && isUnreachable(error)) {
        await this.#probeAfterTransportFailure(error as Error);
      }
      throw error;
    }
  }

  async #probeAfterTransportFailure(error: Error): Promise<void> {
    const health = await getHealth(this.#url, REMOTE_PROBE_TIMEOUT_MS, '/health', this.#fetch);
    this.#probedAt = this.#now();
    if (health === null) {
      this.#state = 'failed';
      this.#detail = error.message;
    }
  }

  async stop(): Promise<void> {
    this.#state = 'stopped';
  }
}
