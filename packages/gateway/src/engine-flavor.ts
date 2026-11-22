import type { InstallFlavor } from './engine-install.ts';
import type { HostInfo } from './engines/descriptor.ts';
import type { HostCapabilities } from './engines/host-capabilities.ts';

/** A strands-decider install flavor picked from the host's hardware, with the line explaining it. */
export interface FlavorChoice {
  readonly flavor: InstallFlavor;
  readonly reason: string;
}

const OVERRIDE = 'pass --flavor cpu|cuda|rocm|mlx to override';

/** Whether `engine install` should probe the hardware: only Linux can have a CUDA or ROCm wheel. */
export function needsHardwareProbe(host: Pick<HostInfo, 'platform'>): boolean {
  return host.platform === 'linux';
}

/**
 * The flavor for an install that names none (`--flavor` wins over this). Apple Silicon implies
 * MLX; on Linux a confirmed NVIDIA GPU picks `cuda`, a confirmed ROCm agent `rocm`; everything
 * else, including an unconfirmed device (`unknown`), keeps the portable `cpu` wheel.
 */
export function flavorFromHardware(
  host: Pick<HostInfo, 'platform' | 'arch'>,
  capabilities?: HostCapabilities,
): FlavorChoice {
  if (host.platform === 'darwin' && host.arch === 'arm64') {
    return { flavor: 'mlx', reason: `flavor mlx: Apple Silicon (${OVERRIDE})` };
  }
  if (capabilities?.nvidia.status === 'available') {
    return {
      flavor: 'cuda',
      reason: `flavor cuda: NVIDIA GPU detected (${capabilities.nvidia.evidence}) (${OVERRIDE})`,
    };
  }
  if (capabilities?.rocm.status === 'available') {
    return {
      flavor: 'rocm',
      reason: `flavor rocm: AMD GPU detected (${capabilities.rocm.evidence}) (${OVERRIDE})`,
    };
  }
  return { flavor: 'cpu', reason: `flavor cpu: no supported GPU detected (${OVERRIDE})` };
}
