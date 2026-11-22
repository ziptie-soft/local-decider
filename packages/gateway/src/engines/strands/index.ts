import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { DEVICES, defineEngine, type EngineContext, type ModelDescriptor } from '../descriptor.ts';
import { checkExtraArgs } from './extra-args.ts';
import { hfCacheDir, hfCached } from './hf-cache.ts';
import { resolveStrandsDevice } from './mlx.ts';
import { MODELS, hfDownloadArgs, isTransformersModel } from './models.ts';
import { StrandsDeciderEngine, strandsBinary } from './server.ts';
import { strandsVenvPackages } from './venv.ts';

export const DEFAULT_MODEL = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

const strandsSchema = z.strictObject({
  type: z.literal('strands-decider'),
  model: z.string().min(1).default(DEFAULT_MODEL),
  device: z.enum(DEVICES).default('auto'),
  /** Attach to a running `strands-decider serve` instead of spawning one. */
  url: z.url().optional(),
  maxBatch: z.number().int().min(1).max(64).default(8),
  /** `serve --max-concurrency` (strands-decider >= 0.4.0): requests run at once; unset = upstream default. */
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  /** Extra `serve` flags, e.g. ["--no-warmup"]. Only flags; never derived from requests. */
  extraArgs: z
    .array(z.string().regex(/^--[a-z][a-z0-9-]*(?:=[\w./:-]+)?$|^[\w./:-]+$/))
    .superRefine(checkExtraArgs)
    .default([]),
  startTimeoutSeconds: z.number().int().min(10).max(3600).default(900),
});

export type StrandsEngineConfig = z.infer<typeof strandsSchema>;

export { hfCached };

function hfCachePath(ctx: EngineContext): string {
  return hfCacheDir(ctx.tools?.env, ctx.env);
}

function strandsModelsPresent(
  models: readonly ModelDescriptor<'strands-decider'>[],
  ctx: EngineContext,
): Promise<ReadonlyMap<string, boolean>> {
  const cache = hfCachePath(ctx);
  return Promise.resolve(
    new Map(
      models.map((model) => [
        model.id,
        (model.artifacts ?? []).every((artifact) =>
          hfCached(cache, artifact, model.revisions?.[artifact]),
        ),
      ]),
    ),
  );
}

function strandsDownloadSteps(
  model: ModelDescriptor<'strands-decider'>,
  ctx: EngineContext,
): { readonly command: string; readonly args: readonly string[] }[] {
  const binary = ctx.tools?.strandsDecider;
  const hf = binary === undefined ? undefined : join(dirname(binary), 'hf');
  if (hf === undefined || !existsSync(hf)) {
    throw new Error(
      'the strands-decider engine is not installed; run `local-decider engine install`',
    );
  }
  return (model.artifacts ?? []).map((artifact) => ({
    command: hf,
    args: hfDownloadArgs(artifact, model.revisions?.[artifact]),
  }));
}

export const strandsEngine = defineEngine({
  id: 'strands-decider',
  label: 'Strands Decider',
  description: 'strands-decider decision engine',
  configSchema: strandsSchema,
  selectable: true,
  supports: () => ({ ok: true }),
  tag: (config, host, ctx) => {
    const binary = ctx?.tools?.strandsDecider ?? (ctx?.paths && strandsBinary(ctx.paths));
    const transformers = isTransformersModel(config.model);
    return resolveStrandsDevice(config.device, host, binary, transformers).backend ?? 'PyTorch';
  },
  devices: (host) => {
    if (host.platform === 'darwin' && host.arch === 'arm64') {
      return ['auto', 'cpu', 'mlx', 'mps'];
    }
    if (host.platform === 'linux') {
      // ROCm torch also reports as `cuda`, so AMD GPUs use this device too.
      return ['auto', 'cpu', 'cuda'];
    }
    return ['auto', 'cpu'];
  },
  calibrated: true,
  models: MODELS,
  runtimeStamp: async (model, ctx) => strandsRuntimeStamp(model.id, ctx),
  modelsPresent: strandsModelsPresent,
  downloadSteps: strandsDownloadSteps,
  create: (config, ctx) => new StrandsDeciderEngine(config, ctx.paths, ctx.tools, ctx.host),
});

function strandsRuntimeVersion(ctx: EngineContext): string | null {
  const packages = strandsVenvPackages(ctx.paths);
  if (packages?.strands === null || packages === null) return null;
  return packages.torch === null
    ? `strands-decider ${packages.strands}`
    : `strands-decider ${packages.strands}, torch ${packages.torch}`;
}

function hubCachePath(ctx: EngineContext): string {
  return (
    ctx.tools?.env['HF_HUB_CACHE'] ??
    ctx.env['HF_HUB_CACHE'] ??
    join(ctx.env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface'), 'hub')
  );
}

export function strandsRuntimeStamp(
  model: string,
  ctx: EngineContext,
): {
  readonly runtime: string | null;
  readonly model: string | null;
} {
  let revision: string | null = null;
  try {
    const ref = join(hubCachePath(ctx), `models--${model.replace('/', '--')}`, 'refs', 'main');
    const contents = readFileSync(ref, 'utf8').trim();
    revision = contents.length === 0 ? null : contents.slice(0, 64);
  } catch {
    revision = null;
  }
  return { runtime: strandsRuntimeVersion(ctx), model: revision };
}
