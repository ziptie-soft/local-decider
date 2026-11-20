import { join } from 'node:path';

import type { StrandsEngineConfig } from '../../config.ts';
import type { Paths } from '../../paths.ts';
import type { Toolchain } from '../../toolchain.ts';
import type { Device, HostInfo } from '../descriptor.ts';
import { SupervisedEngine, type ServerSpec } from '../supervised.ts';
import { hfCacheDir, pinnedCheckpoint } from './hf-cache.ts';
import { resolveStrandsDevice, type DeviceResolution } from './mlx.ts';
import { isTransformersModel } from './models.ts';

const STRANDS_VENV = 'strands-decider';

export function strandsBinary(paths: Paths): string {
  return join(paths.venvs, STRANDS_VENV, 'bin', 'strands-decider');
}

/** `serve` argv. Every element comes from validated config, never from a request. */
export function serveArgs(
  config: StrandsEngineConfig,
  port: number,
  /** The device resolved for this launch; an explicit config device when omitted. */
  device: Exclude<Device, 'auto'> | undefined = config.device === 'auto'
    ? undefined
    : config.device,
  /** A pinned HF snapshot directory to serve instead of the repo id (see `pinnedCheckpoint`). */
  checkpoint?: string,
): string[] {
  const args = ['serve', checkpoint ?? config.model, '--host', '127.0.0.1', '--port', String(port)];
  if (checkpoint !== undefined) {
    // Upstream names the model after the checkpoint's basename, which would now be the sha.
    args.push('--model-name', config.model.split('/').pop() ?? config.model);
  }
  if (device !== undefined) {
    args.push('--device', device);
  }
  args.push('--max-batch', String(config.maxBatch));
  if (config.maxConcurrency !== undefined) {
    args.push('--max-concurrency', String(config.maxConcurrency));
  }
  // Warmup compiles kernel shapes; on CPU there is nothing to compile and it adds ~27 s to every
  // start (ready in 4.6 s without it, first request no slower). `--warmup` in extraArgs opts back in.
  if (device === 'cpu' && !config.extraArgs.some((a) => a === '--warmup' || a === '--no-warmup')) {
    args.push('--no-warmup');
  }
  args.push(...config.extraArgs);
  return args;
}

function strandsSpec(
  config: StrandsEngineConfig,
  paths: Paths,
  tools?: Toolchain,
  host?: HostInfo,
): ServerSpec {
  const binary = tools?.strandsDecider ?? strandsBinary(paths);
  // Resolved once per launch (refreshed in `binary()`), so argv and health agree.
  const transformers = isTransformersModel(config.model);
  let device: DeviceResolution = resolveStrandsDevice(config.device, host, binary, transformers);
  return {
    id: 'strands-decider',
    model: config.model,
    url: config.url,
    startTimeoutSeconds: config.startTimeoutSeconds,
    healthPath: '/health',
    env: { PYTHONUNBUFFERED: '1', ...tools?.env },
    binary: () => {
      if (transformers && config.device === 'mlx') {
        // Fail the start with a clear reason rather than let upstream reject the flag.
        return {
          missing:
            'v2 checkpoints use the transformers backend, which has no MLX device; set device to auto, mps or cpu',
        };
      }
      device = resolveStrandsDevice(config.device, host, binary, transformers);
      return {
        path: binary,
        missing: `${binary} not found; run \`local-decider engine install\``,
      };
    },
    args: (port) =>
      serveArgs(
        config,
        port,
        device.resolved,
        pinnedCheckpoint(hfCacheDir(tools?.env, process.env), config.model),
      ),
    deviceInfo: () => device,
    maxLength: (body) => (typeof body['max_length'] === 'number' ? body['max_length'] : undefined),
  };
}

/**
 * strands-decider: spawned from the managed venv (`local-decider engine install`) on a free
 * loopback port and supervised with restart backoff, or attached to `config.url`.
 */
export class StrandsDeciderEngine extends SupervisedEngine {
  constructor(config: StrandsEngineConfig, paths: Paths, tools?: Toolchain, host?: HostInfo) {
    super(strandsSpec(config, paths, tools, host), paths);
  }
}
