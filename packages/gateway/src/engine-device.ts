/**
 * Keep the configured strands-decider device consistent with the torch build `engine install`
 * just put in the venv. `selection.device` and `engine.device` both exist by design:
 * `selection` (set by the settings pages and `engine use`) wins whenever it names a usable engine
 * and model (`EngineControl.#initialSelection`), `engine.device` is the fallback; so both are kept
 * in line. A device the installed flavor cannot serve (a `cuda` device on CPU-only torch) crashes
 * the engine at start (`Torch not compiled with CUDA enabled`), so install rewrites it.
 *
 * Rewrite rules, per flavor (`auto` is never touched; the target is `FLAVOR_DEVICE`):
 * - `cpu`: any device the CPU build cannot serve becomes `cpu` (`mps` is kept on macOS).
 * - `cuda` / `rocm`: an incompatible device (`mlx`, `mps`) becomes `cuda` (ROCm torch names the AMD
 *   GPU `cuda`). An explicit `cpu` device is also upgraded to `cuda`, on purpose: asking for a GPU
 *   build means using the GPU. The printed notice says so.
 * - `mlx`: any other explicit device becomes `mlx`, `cpu` included, except for v2 (transformers)
 *   models, which are left alone because MLX is v1-only.
 * `Device` is a closed set, so there is no custom or unknown device to skip here. `selection.device`
 * and `engine.device` are both rewritten, so they stay consistent.
 */
import { ConfigFile, type ConfigEdit } from './config-file.ts';
import type { GatewayConfig } from './config.ts';
import type { InstallFlavor } from './engine-install.ts';
import type { Device } from './engines/descriptor.ts';
import { isTransformersModel } from './engines/strands/models.ts';
import type { Paths } from './paths.ts';

/** The device each flavor is for. ROCm torch reports the AMD GPU as `cuda` (`serve --device cuda`). */
const FLAVOR_DEVICE: Readonly<Record<InstallFlavor, Exclude<Device, 'auto' | 'mps'>>> = {
  cpu: 'cpu',
  mlx: 'mlx',
  cuda: 'cuda',
  rocm: 'cuda',
};

/**
 * Whether the torch (or MLX) build of `flavor` can run on `device`. `auto` always can; `mlx` only
 * serves `mlx`; `cpu` serves `cpu` (and `mps` on macOS); `cuda`/`rocm` serve `cuda` and `cpu`.
 */
function serves(flavor: InstallFlavor, device: Device, platform: NodeJS.Platform): boolean {
  if (device === 'auto') {
    return true;
  }
  if (flavor === 'mlx') {
    return device === 'mlx';
  }
  if (flavor === 'cpu') {
    // PyPI torch on macOS ships MPS; the Linux CPU wheel cannot do anything but CPU.
    return device === 'cpu' || (device === 'mps' && platform === 'darwin');
  }
  // cuda and rocm: a GPU build still runs on the CPU.
  return device === 'cuda' || device === 'cpu';
}

/**
 * A GPU torch build (`cuda`/`rocm`) installed over an explicit `cpu` device is upgraded to `cuda`
 * even though `serves` accepts it: the GPU would otherwise sit idle, and a GPU build means use it.
 */
function upgrades(flavor: InstallFlavor, device: Device): boolean {
  return (flavor === 'cuda' || flavor === 'rocm') && device === 'cpu';
}

interface DeviceChange {
  /** `selection.device` or `engine.device`. */
  readonly key: string;
  readonly from: Device;
  readonly to: Device;
  /** The flavor cannot serve `from`, or it can but a GPU is available. */
  readonly why: 'incompatible' | 'gpu';
}

function candidates(config: GatewayConfig): { key: string; device: Device; model: string }[] {
  const found: { key: string; device: Device; model: string }[] = [];
  const { selection, engine } = config;
  if (selection?.engine === 'strands-decider' && selection.device !== undefined) {
    found.push({
      key: 'selection.device',
      device: selection.device,
      model: selection.model ?? engine.model,
    });
  }
  if (engine.type === 'strands-decider') {
    found.push({ key: 'engine.device', device: engine.device, model: engine.model });
  }
  return found;
}

/** The device edits `flavor` calls for; none when the config already fits it. */
function deviceChanges(
  config: GatewayConfig,
  flavor: InstallFlavor,
  platform: NodeJS.Platform,
): DeviceChange[] {
  const to = FLAVOR_DEVICE[flavor];
  return (
    candidates(config)
      .filter((c) => !serves(flavor, c.device, platform) || upgrades(flavor, c.device))
      // v2 checkpoints have no MLX backend: leave them to the engine's own refusal.
      .filter((c) => !(to === 'mlx' && isTransformersModel(c.model)))
      .map((c) => ({
        key: c.key,
        from: c.device,
        to,
        why: serves(flavor, c.device, platform) ? ('gpu' as const) : ('incompatible' as const),
      }))
  );
}

/**
 * Rewrite incompatible devices (and a `cpu` device under a GPU flavor) in config.yaml, through
 * `ConfigFile`, which keeps comments and validates. Rules are in the file header. Returns the
 * one-line notice, or `undefined` when nothing changed.
 */
export function reconcileDevice(
  paths: Paths,
  flavor: InstallFlavor,
  platform: NodeJS.Platform,
): string | undefined {
  const store = ConfigFile.open(paths);
  const changes = deviceChanges(store.current, flavor, platform);
  if (changes.length === 0) {
    return undefined;
  }
  const edits: ConfigEdit[] = changes.map((c) => ({ path: c.key.split('.'), value: c.to }));
  store.update(edits);
  const list = changes.map((c) => `${c.key} ${c.from} -> ${c.to}`).join(', ');
  const reason = changes.every((c) => c.why === 'gpu')
    ? `the ${flavor} flavor runs on the GPU, so the cpu device was switched`
    : `the ${flavor} flavor cannot serve the old device`;
  return `config: ${list} (${reason}; edited ${store.file})`;
}
