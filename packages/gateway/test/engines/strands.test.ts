import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { downloadSteps } from '../../src/downloads.ts';
import { planCatalogueDownloads } from '../../src/engine-install.ts';
import type { EngineContext, HostInfo } from '../../src/engines/descriptor.ts';
import { pinnedCheckpoint } from '../../src/engines/strands/hf-cache.ts';
import { strandsEngine, hfCached } from '../../src/engines/strands/index.ts';
import { resolveStrandsDevice } from '../../src/engines/strands/mlx.ts';
import { hfDownloadArgs } from '../../src/engines/strands/models.ts';
import { serveArgs } from '../../src/engines/strands/server.ts';
import { tempPaths } from '../helpers.ts';

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

function mlxVenv(root: string): string {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib', 'python3.13', 'site-packages', 'mlx_lm'), { recursive: true });
  return join(root, 'bin', 'strands-decider');
}

function context(data: string, binary?: string, hfCache?: string): EngineContext {
  return {
    paths: {
      data,
      config: join(data, 'config'),
      logs: join(data, 'logs'),
      venvs: join(data, 'venvs'),
      engines: join(data, 'engines'),
      run: join(data, 'run'),
    },
    tools: {
      flm: undefined,
      strandsDecider: binary,
      uv: undefined,
      env: hfCache === undefined ? {} : { HF_HUB_CACHE: hfCache },
    },
    host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 },
    env: {},
  };
}

describe('strands descriptor', () => {
  it('detects Hugging Face cache snapshots and model presence', async () => {
    const paths = tempPaths();
    const model = strandsEngine.models[0];
    assert.ok(model);
    assert.ok(strandsEngine.modelsPresent !== undefined);
    const cache = join(paths.data, 'hf-cache');
    assert.equal(hfCached(cache, model.artifacts?.[0] ?? ''), false);
    assert.equal(
      (await strandsEngine.modelsPresent([model], context(paths.data, undefined, cache))).get(
        model.id,
      ),
      false,
    );
    for (const artifact of model.artifacts ?? []) {
      const snapshot = join(
        cache,
        `models--${artifact.replace('/', '--')}`,
        'snapshots',
        model.revisions?.[artifact] ?? 'abc',
      );
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, 'config.json'), '{}');
    }
    assert.equal(hfCached(cache, model.artifacts?.[0] ?? ''), true);
    assert.equal(
      (await strandsEngine.modelsPresent([model], context(paths.data, undefined, cache))).get(
        model.id,
      ),
      true,
    );
  });

  it('builds fixed HF argv from the engine catalogue', () => {
    const paths = tempPaths();
    const binary = executable(join(paths.venvs, 'strands-decider', 'bin', 'strands-decider'));
    const hf = executable(join(paths.venvs, 'strands-decider', 'bin', 'hf'));
    const model = strandsEngine.models.find((entry) => entry.id.includes('2B-qwen3.5'));
    assert.ok(model);
    assert.deepEqual(downloadSteps(model, context(paths.data, binary)), [
      {
        command: hf,
        args: hfDownloadArgs(
          model.artifacts?.[0] ?? '',
          model.revisions?.[model.artifacts?.[0] ?? ''],
        ),
      },
      {
        command: hf,
        args: hfDownloadArgs(
          model.artifacts?.[1] ?? '',
          model.revisions?.[model.artifacts?.[1] ?? ''],
        ),
      },
    ]);
  });

  it('pins every catalogue artifact to a 40-char commit', () => {
    for (const model of strandsEngine.models) {
      assert.ok((model.artifacts ?? []).length > 0, model.id);
      assert.deepEqual(
        Object.keys(model.revisions ?? {}).toSorted(),
        [...(model.artifacts ?? [])].toSorted(),
      );
      for (const rev of Object.values(model.revisions ?? {})) {
        assert.match(rev, /^[0-9a-f]{40}$/);
      }
    }
  });

  it('passes --revision to hf download', () => {
    const model = strandsEngine.models[0];
    assert.ok(model);
    const binary = executable(join(tempPaths().venvs, 'strands-decider', 'bin', 'strands-decider'));
    executable(join(dirname(binary), 'hf'));
    const steps = downloadSteps(model, context(tempPaths().data, binary));
    for (const step of steps) {
      assert.equal(step.args[2], '--revision');
      assert.match(step.args[3] ?? '', /^[0-9a-f]{40}$/);
    }
  });

  it('checks the pinned snapshot in the HF cache', () => {
    const cache = join(tempPaths().data, 'hf-cache');
    const snap = join(cache, 'models--a--b', 'snapshots', 'other');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'f'), '');
    assert.equal(hfCached(cache, 'a/b'), true);
    assert.equal(hfCached(cache, 'a/b', 'pinned'), false);
    const pinned = join(cache, 'models--a--b', 'snapshots', 'pinned');
    mkdirSync(pinned);
    writeFileSync(join(pinned, 'f'), '');
    assert.equal(hfCached(cache, 'a/b', 'pinned'), true);
  });

  it('refuses a base_model outside the descriptor artifacts', () => {
    const model = strandsEngine.models[0];
    assert.ok(model);
    assert.throws(() => planCatalogueDownloads(model, 'evil/base'), /not one of its pinned/);
    const plan = planCatalogueDownloads(model, model.artifacts?.[1] ?? '');
    assert.equal(plan.length, 2);
    assert.equal(plan[0]?.[2], '--revision');
  });

  it('refuses catalogue pin drift against provenance', () => {
    const model = strandsEngine.models[0];
    assert.ok(model);
    const base = model.artifacts?.[1] ?? '';
    const pinned = model.revisions?.[base] ?? '';
    assert.throws(() => planCatalogueDownloads(model, base, 'f'.repeat(40)), /pin drift/);
    assert.equal(planCatalogueDownloads(model, base, pinned).length, 2);
    assert.equal(planCatalogueDownloads(model, base, '').length, 2);
  });

  it('serves the pinned snapshot directory when cached, else the repo id', () => {
    const model = strandsEngine.models[0];
    assert.ok(model);
    const cache = join(tempPaths().data, 'hf-cache');
    assert.equal(pinnedCheckpoint(cache, model.id), undefined);
    const rev = model.revisions?.[model.id] ?? '';
    const snap = join(cache, `models--${model.id.replace('/', '--')}`, 'snapshots', rev);
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'config.json'), '{}');
    assert.equal(pinnedCheckpoint(cache, model.id), snap);
    assert.equal(pinnedCheckpoint(cache, 'user/unlisted'), undefined);
    const config = strandsEngine.configSchema.parse({ type: 'strands-decider', model: model.id });
    const args = serveArgs(config, 9000, undefined, snap);
    assert.equal(args[1], snap);
    assert.deepEqual(args.slice(args.indexOf('--model-name')), [
      '--model-name',
      'strands-decider-2B-qwen3.5-v1-2610',
      ...args.slice(args.indexOf('--model-name') + 2),
    ]);
    assert.equal(serveArgs(config, 9000)[1], model.id);
    assert.ok(!serveArgs(config, 9000).includes('--model-name'));
  });

  describe('device resolution', () => {
    const darwin: HostInfo = { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 64e9 };
    const linux: HostInfo = { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 };

    it('resolves auto to MLX on darwin/arm64 with mlx_lm', () => {
      const binary = mlxVenv(join(tempPaths().venvs, 'mlx'));
      const r = resolveStrandsDevice('auto', darwin, binary);
      assert.deepEqual(r, { requested: 'auto', resolved: 'mlx', backend: 'MLX' });
    });

    it('leaves auto unknown without mlx_lm or off Apple Silicon', () => {
      const plain = join(tempPaths().venvs, 'plain', 'bin', 'strands-decider');
      assert.equal(resolveStrandsDevice('auto', darwin, plain).resolved, undefined);
      assert.equal(resolveStrandsDevice('auto', darwin, plain).backend, undefined);
      const binary = mlxVenv(join(tempPaths().venvs, 'mlx'));
      assert.equal(resolveStrandsDevice('auto', linux, binary).resolved, undefined);
    });

    it('lets an explicit device win', () => {
      const binary = mlxVenv(join(tempPaths().venvs, 'mlx'));
      assert.deepEqual(resolveStrandsDevice('cpu', darwin, binary), {
        requested: 'cpu',
        resolved: 'cpu',
        backend: 'CPU',
      });
      assert.equal(resolveStrandsDevice('cuda', linux, undefined).backend, 'CUDA');
      assert.equal(resolveStrandsDevice('mps', darwin, undefined).backend, 'MPS');
    });

    it('checks the venv of a custom executable, not the managed one', () => {
      const paths = tempPaths();
      mlxVenv(join(paths.venvs, 'strands-decider')); // managed venv has mlx
      const custom = executable(join(paths.data, 'custom', 'bin', 'strands-decider'));
      assert.equal(resolveStrandsDevice('auto', darwin, custom).resolved, undefined);
      const customMlx = mlxVenv(join(paths.data, 'custom-mlx'));
      assert.equal(resolveStrandsDevice('auto', darwin, customMlx).resolved, 'mlx');
    });

    it('tags MLX under auto on Apple Silicon with mlx_lm, PyTorch when unknown', () => {
      const paths = tempPaths();
      const config = strandsEngine.configSchema.parse({ type: 'strands-decider' });
      const ctx = { paths: context(paths.data).paths };
      assert.equal(strandsEngine.tag(config, darwin, ctx), 'PyTorch');
      mlxVenv(join(paths.venvs, 'strands-decider'));
      assert.equal(strandsEngine.tag(config, darwin, ctx), 'MLX');
      assert.equal(strandsEngine.tag({ ...config, device: 'mps' }, darwin, ctx), 'MPS');
      assert.equal(strandsEngine.tag(config, linux, ctx), 'PyTorch');
    });

    it('builds argv from the single resolved device', () => {
      const config = strandsEngine.configSchema.parse({ type: 'strands-decider' });
      assert.ok(!serveArgs(config, 9000, undefined).includes('--device'));
      const args = serveArgs(config, 9000, 'mlx');
      assert.deepEqual(args.slice(args.indexOf('--device'), args.indexOf('--device') + 2), [
        '--device',
        'mlx',
      ]);
      assert.ok(serveArgs(config, 9000, 'cpu').includes('--no-warmup'));
    });
  });
});
