import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Device, HostInfo } from '../descriptor.ts';

function pythonVersions(venv: string): string[] {
  try {
    return readdirSync(join(venv, 'lib'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^python3\.\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Whether any `site-packages` of the venv has an entry matching `test`; never starts Python. */
function venvHas(venv: string, test: (name: string) => boolean): boolean {
  return pythonVersions(venv).some((version) => {
    try {
      return readdirSync(join(venv, 'lib', version, 'site-packages'), {
        withFileTypes: true,
      }).some((entry) => entry.isDirectory() && test(entry.name));
    } catch {
      return false;
    }
  });
}

function venvHasMlx(venv: string): boolean {
  return venvHas(venv, (name) => name === 'mlx_lm');
}

/** A ROCm torch wheel, e.g. `torch-2.14.1+rocm7.2.dist-info`: it serves AMD GPUs as `cuda`. */
function venvHasRocmTorch(venv: string): boolean {
  return venvHas(venv, (name) => /^torch-[^+]*\+rocm[^/]*\.dist-info$/i.test(name));
}

/** `auto` prefers MLX only for Apple Silicon venvs that contain mlx_lm. */
function resolveDevice(
  device: Device,
  host?: HostInfo,
  venv?: string,
  transformers = false,
): Device | undefined {
  if (transformers && (device === 'auto' || device === 'mlx')) {
    // v2 checkpoints have no MLX backend; the config schema rejects an explicit `mlx`, and `auto`
    // omits --device so upstream picks cuda/mps/cpu itself.
    return undefined;
  }
  if (device !== 'auto') {
    return device;
  }
  if (host?.platform !== 'darwin' || host.arch !== 'arm64' || venv === undefined) {
    return undefined;
  }
  return venvHasMlx(venv) ? 'mlx' : undefined;
}

/** Backend tag per concrete device. */
const BACKENDS: Readonly<Record<Exclude<Device, 'auto'>, string>> = {
  mlx: 'MLX',
  mps: 'MPS',
  cuda: 'CUDA',
  cpu: 'CPU',
};

/** ROCm torch names the AMD GPU `cuda`; the torch wheel's local label tells the two apart. */
function backendOf(device: Exclude<Device, 'auto'>, venv: string | undefined): string {
  return device === 'cuda' && venv !== undefined && venvHasRocmTorch(venv)
    ? 'ROCm'
    : BACKENDS[device];
}

export interface DeviceResolution {
  readonly requested: Device;
  /** Undefined when `auto` has no cheap evidence; the child then picks and reports its own. */
  readonly resolved: Exclude<Device, 'auto'> | undefined;
  /** `MLX`, `MPS`, `CUDA`, `ROCm` or `CPU`; undefined while the backend is unknown. */
  readonly backend: string | undefined;
}

/** The venv an executable lives in: `<venv>/bin/<name>`, following symlinks. */
function venvOfExecutable(binary: string): string {
  let real = binary;
  try {
    real = realpathSync(binary);
  } catch {
    // Not installed yet: the lexical location is still the venv it would live in.
  }
  return dirname(dirname(real));
}

/**
 * Resolves `device` once, from the venv that `binary` belongs to. Explicit devices win, except
 * that a v2 (`transformers`) model never resolves to MLX.
 */
export function resolveStrandsDevice(
  device: Device,
  host: HostInfo | undefined,
  binary: string | undefined,
  transformers = false,
): DeviceResolution {
  const venv = binary === undefined ? undefined : venvOfExecutable(binary);
  const resolved = resolveDevice(device, host, venv, transformers);
  const concrete = resolved === undefined || resolved === 'auto' ? undefined : resolved;
  return {
    requested: device,
    resolved: concrete,
    backend: concrete === undefined ? undefined : backendOf(concrete, venv),
  };
}
