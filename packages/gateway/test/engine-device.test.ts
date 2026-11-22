import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ConfigFile } from '../src/config-file.ts';
import { reconcileDevice } from '../src/engine-device.ts';
import type { InstallFlavor } from '../src/engine-install.ts';
import type { Paths } from '../src/paths.ts';
import { tempPaths } from './helpers.ts';

const V1 = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
const V2 = 'StrandsAgents/strands-decider-E2B-gemma4-v2-2611';

function configured(yaml: string): Paths {
  const paths = tempPaths();
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(join(paths.config, 'config.yaml'), yaml);
  return paths;
}

const CUDA_ON_CPU = `# my settings
engine:
  type: strands-decider
  model: ${V1}
  device: cpu
selection:
  engine: strands-decider
  model: ${V1}
  device: cuda
`;

describe('engine install device reconciliation', () => {
  it('rewrites a cuda selection when the cpu flavor is installed, keeping comments', () => {
    const paths = configured(CUDA_ON_CPU);
    const notice = reconcileDevice(paths, 'cpu', 'linux');
    assert.match(notice ?? '', /selection\.device cuda -> cpu/);
    assert.doesNotMatch(notice ?? '', /engine\.device/);
    const store = ConfigFile.open(paths);
    assert.equal(store.current.selection?.device, 'cpu');
    assert.equal(
      store.current.engine.type === 'strands-decider' && store.current.engine.device,
      'cpu',
    );
    assert.match(readText(paths), /# my settings/);
  });

  it('keeps engine.device and selection.device consistent', () => {
    const paths = configured(CUDA_ON_CPU.replace('device: cpu', 'device: cuda'));
    const notice = reconcileDevice(paths, 'cpu', 'linux');
    assert.match(notice ?? '', /selection\.device cuda -> cpu, engine\.device cuda -> cpu/);
    const { current } = ConfigFile.open(paths);
    assert.equal(current.selection?.device, 'cpu');
    assert.equal(current.engine.type === 'strands-decider' && current.engine.device, 'cpu');
  });

  it('maps rocm to cuda (ROCm torch reports the GPU as cuda) and mlx to mlx', () => {
    const rocm = configured(CUDA_ON_CPU.replace('device: cuda', 'device: mlx'));
    assert.match(reconcileDevice(rocm, 'rocm', 'linux') ?? '', /selection\.device mlx -> cuda/);
    assert.equal(ConfigFile.open(rocm).current.selection?.device, 'cuda');
    const mlx = configured(CUDA_ON_CPU);
    assert.match(reconcileDevice(mlx, 'mlx', 'darwin') ?? '', /selection\.device cuda -> mlx/);
    assert.equal(ConfigFile.open(mlx).current.selection?.device, 'mlx');
  });

  it('leaves devices the flavor can serve alone', () => {
    const cases: [InstallFlavor, NodeJS.Platform, string][] = [
      ['cpu', 'linux', 'cpu'],
      ['cpu', 'linux', 'auto'],
      ['cpu', 'darwin', 'mps'],
      ['cuda', 'linux', 'cuda'],
      ['rocm', 'linux', 'cuda'],
      ['mlx', 'darwin', 'mlx'],
    ];
    for (const [flavor, platform, device] of cases) {
      const paths = configured(CUDA_ON_CPU.replaceAll(/device: \w+/g, `device: ${device}`));
      assert.equal(reconcileDevice(paths, flavor, platform), undefined, `${flavor}/${device}`);
      assert.equal(ConfigFile.open(paths).current.selection?.device, device);
    }
  });

  it('switches a cpu device to the GPU when a cuda or rocm flavor is installed', () => {
    for (const flavor of ['cuda', 'rocm'] as const) {
      const paths = configured(CUDA_ON_CPU.replace('device: cuda', 'device: cpu'));
      const notice = reconcileDevice(paths, flavor, 'linux');
      assert.match(notice ?? '', /selection\.device cpu -> cuda, engine\.device cpu -> cuda/);
      assert.match(notice ?? '', new RegExp(`${flavor} flavor runs on the GPU`));
      const { current } = ConfigFile.open(paths);
      assert.equal(current.selection?.device, 'cuda');
      assert.equal(current.engine.type === 'strands-decider' && current.engine.device, 'cuda');
      assert.match(readText(paths), /# my settings/);
    }
  });

  it('still forces cpu for the cpu flavor, and keeps auto and an explicit GPU device', () => {
    const forced = configured(CUDA_ON_CPU);
    assert.match(reconcileDevice(forced, 'cpu', 'linux') ?? '', /cuda -> cpu/);
    assert.equal(ConfigFile.open(forced).current.selection?.device, 'cpu');
    for (const device of ['auto', 'cuda']) {
      const paths = configured(CUDA_ON_CPU.replaceAll(/device: \w+/g, `device: ${device}`));
      assert.equal(reconcileDevice(paths, 'rocm', 'linux'), undefined, device);
    }
  });

  it('turns an mlx flavor on a cpu device into mlx, but not for a v2 model', () => {
    const v1 = configured(CUDA_ON_CPU.replace('device: cuda', 'device: cpu'));
    assert.match(reconcileDevice(v1, 'mlx', 'darwin') ?? '', /selection\.device cpu -> mlx/);
    const v2 = configured(CUDA_ON_CPU.replace('device: cuda', 'device: cpu').replaceAll(V1, V2));
    assert.equal(reconcileDevice(v2, 'mlx', 'darwin'), undefined);
  });

  it('does not treat mps as served by the Linux cpu flavor', () => {
    const paths = configured(CUDA_ON_CPU.replace('device: cuda', 'device: mps'));
    assert.match(reconcileDevice(paths, 'cpu', 'linux') ?? '', /selection\.device mps -> cpu/);
  });

  it('ignores a selection of another engine and a missing config', () => {
    const other = configured(
      `selection:\n  engine: llama-vulkan\n  model: d3-mini-q4_k_m\nengine:\n  type: llama-vulkan\n  model: d3-mini-q4_k_m\n`,
    );
    assert.equal(reconcileDevice(other, 'cpu', 'linux'), undefined);
    assert.equal(reconcileDevice(tempPaths(), 'cpu', 'linux'), undefined);
  });

  it('does not force mlx on a v2 model, which has no MLX backend', () => {
    const paths = configured(CUDA_ON_CPU.replaceAll(V1, V2));
    assert.equal(reconcileDevice(paths, 'mlx', 'darwin'), undefined);
    assert.equal(ConfigFile.open(paths).current.selection?.device, 'cuda');
  });
});

function readText(paths: Paths): string {
  return readFileSync(join(paths.config, 'config.yaml'), 'utf8');
}
