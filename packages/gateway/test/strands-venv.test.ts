import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { engineProjectDir } from '../src/engine-install.ts';
import {
  pinnedStrandsVersion,
  strandsDeviceProblem,
  strandsPinMismatch,
} from '../src/engines/strands/venv.ts';
import { tempPaths } from './helpers.ts';

function project(pin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ld-pin-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    `[project]\ndependencies = [\n  "strands-decider==${pin}",\n]\n`,
  );
  return dir;
}

function venvWith(installed: string | null): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  const site = join(paths.venvs, 'strands-decider', 'lib', 'python3.12', 'site-packages');
  mkdirSync(site, { recursive: true });
  if (installed !== null) mkdirSync(join(site, `strands_decider-${installed}.dist-info`));
  return paths;
}

function venvWithTorch(torch: string | null): ReturnType<typeof tempPaths> {
  const paths = venvWith('0.4.0');
  if (torch !== null) {
    const site = join(paths.venvs, 'strands-decider', 'lib', 'python3.12', 'site-packages');
    mkdirSync(join(site, `torch-${torch}.dist-info`));
  }
  return paths;
}

describe('Strands venv pin check', () => {
  it('reports a venv older than the pin, with the remedy', () => {
    assert.equal(
      strandsPinMismatch(venvWith('0.3.1.dev2+g846b69e'), project('0.4.0')),
      'strands-decider venv has 0.3.1.dev2+g846b69e, pinned 0.4.0; run local-decider engine install',
    );
  });

  it('reports nothing for a matching venv', () => {
    assert.equal(strandsPinMismatch(venvWith('0.4.0'), project('0.4.0')), null);
  });

  it('reports nothing for a missing venv or a venv without strands-decider', () => {
    assert.equal(strandsPinMismatch(tempPaths(), project('0.4.0')), null);
    assert.equal(strandsPinMismatch(venvWith(null), project('0.4.0')), null);
  });

  it('parses a pin with extras or whitespace and accepts a local version of the pin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ld-pin-'));
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[project]\ndependencies = ["Strands_Decider[mlx] == 0.4.0"]\n',
    );
    assert.equal(pinnedStrandsVersion(dir), '0.4.0');
    assert.equal(strandsPinMismatch(venvWith('0.4.0+local'), dir), null);
    assert.notEqual(strandsPinMismatch(venvWith('0.4.1+local'), dir), null);
  });

  it('reports nothing when the pin is unreadable', () => {
    assert.equal(strandsPinMismatch(venvWith('0.3.1'), tmpdir()), null);
  });

  describe('device check', () => {
    it('flags cuda on a +cpu torch, with the remedy', () => {
      const problem = strandsDeviceProblem(venvWithTorch('2.9.0+cpu'), 'cuda', 'linux');
      assert.match(problem ?? '', /device cuda is configured but the venv has a CPU-only torch/);
      assert.match(problem ?? '', /engine install --flavor cuda/);
    });

    it('accepts cuda on CUDA and ROCm torch, and cpu or auto on any build', () => {
      for (const torch of ['2.9.0+cu126', '2.9.0+rocm7.2', '2.9.0']) {
        assert.equal(strandsDeviceProblem(venvWithTorch(torch), 'cuda', 'linux'), null, torch);
      }
      for (const device of ['cpu', 'auto', 'mlx']) {
        assert.equal(strandsDeviceProblem(venvWithTorch('2.9.0+cpu'), device, 'linux'), null);
      }
    });

    it('flags cuda on unlabeled macOS torch and mps off macOS', () => {
      assert.match(
        strandsDeviceProblem(venvWithTorch('2.9.0'), 'cuda', 'darwin') ?? '',
        /CPU-only torch/,
      );
      assert.match(
        strandsDeviceProblem(venvWithTorch('2.9.0+cu126'), 'mps', 'linux') ?? '',
        /mps needs macOS/,
      );
      assert.equal(strandsDeviceProblem(venvWithTorch('2.9.0'), 'mps', 'darwin'), null);
    });

    it('reports nothing without a venv or torch (the MLX flavor has none)', () => {
      assert.equal(strandsDeviceProblem(tempPaths(), 'cuda', 'linux'), null);
      assert.equal(strandsDeviceProblem(venvWithTorch(null), 'cuda', 'linux'), null);
    });
  });

  it('reads the bundled pin', () => {
    const pin = pinnedStrandsVersion();
    assert.ok(pin !== null);
    assert.match(readFileSync(join(engineProjectDir(), 'pyproject.toml'), 'utf8'), new RegExp(pin));
  });
});
