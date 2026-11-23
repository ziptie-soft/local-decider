import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { EngineContext, ModelDescriptor } from '../../src/engines/descriptor.ts';
import { removeFlmModel } from '../../src/engines/fastflowlm/remove.ts';
import { ggufPath, LLAMA_MODELS } from '../../src/engines/llama/models.ts';
import { removeLlamaModel } from '../../src/engines/llama/remove.ts';
import { recordPath } from '../../src/engines/llama/verified.ts';
import { MODELS } from '../../src/engines/strands/models.ts';
import { removeStrandsModel } from '../../src/engines/strands/remove.ts';
import type { Paths } from '../../src/paths.ts';
import { tempPaths } from '../helpers.ts';

const HOST = { platform: 'linux', arch: 'x64', totalMemoryBytes: 8e9 } as const;

function context(paths: Paths, extra: Partial<EngineContext> = {}): EngineContext {
  return { paths, host: HOST, env: {}, ...extra };
}

function strands(id: string): ModelDescriptor<'strands-decider'> {
  const model = MODELS.find((m) => m.id === id);
  assert.ok(model);
  return model;
}

function cacheRepo(cache: string, repo: string, revision: string): string {
  const dir = join(cache, `models--${repo.replace('/', '--')}`);
  mkdirSync(join(dir, 'snapshots', revision), { recursive: true });
  writeFileSync(join(dir, 'snapshots', revision, 'config.json'), '{}');
  return dir;
}

function cacheModel(cache: string, model: ModelDescriptor<'strands-decider'>): string[] {
  return (model.artifacts ?? []).map((repo) =>
    cacheRepo(cache, repo, model.revisions?.[repo] ?? 'main'),
  );
}

function flmModel(id: string): ModelDescriptor<'fastflowlm'> {
  return { id, engine: 'fastflowlm' } as ModelDescriptor<'fastflowlm'>;
}

describe('removing downloaded models', () => {
  it('deletes a llama GGUF and its verification record', async () => {
    const paths = tempPaths();
    const model = LLAMA_MODELS[0]!;
    const path = ggufPath(paths, model.id);
    assert.ok(path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'gguf');
    writeFileSync(recordPath(path), '{}');
    await removeLlamaModel(model, context(paths));
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(recordPath(path)), false);
    await removeLlamaModel(model, context(paths));
  });

  it('deletes strands repos but keeps a base another installed model uses', async () => {
    const paths = tempPaths();
    const cache = join(paths.data, 'hf');
    const ctx = context(paths, { env: { HF_HUB_CACHE: cache } });
    const first = strands('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610');
    const second = strands('StrandsAgents/strands-decider-2B-hobson-v21');
    const [adapter, base] = cacheModel(cache, first);
    const [otherAdapter] = cacheModel(cache, second);
    assert.ok(adapter !== undefined && base !== undefined && otherAdapter !== undefined);

    await removeStrandsModel(first, ctx);
    assert.equal(existsSync(adapter), false);
    assert.equal(existsSync(base), true);
    assert.equal(existsSync(otherAdapter), true);

    await removeStrandsModel(second, ctx);
    assert.equal(existsSync(otherAdapter), false);
    assert.equal(existsSync(base), false);
  });

  it('runs flm remove and fails on an [ERROR] line', async () => {
    const paths = tempPaths();
    const flm = join(paths.data, 'flm');
    const log = join(paths.data, 'argv');
    writeFileSync(
      flm,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' '));
if (process.argv[3] === 'd3:mini') console.log('[ERROR]  Model not found: d3:mini');
else console.log('Successfully removed');
`,
    );
    chmodSync(flm, 0o755);
    const tools = { flm, env: {} } as unknown as NonNullable<EngineContext['tools']>;
    const ctx = context(paths, { tools });
    await removeFlmModel(flmModel('d3:nano'), ctx);
    assert.equal(readFileSync(log, 'utf8'), 'remove d3:nano');
    await assert.rejects(removeFlmModel(flmModel('d3:mini'), ctx), /Model not found: d3:mini/);
    await assert.rejects(removeFlmModel(flmModel('d3:nano'), context(paths)), /not installed/);
  });
});
