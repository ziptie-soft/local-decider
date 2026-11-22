import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { EngineContext } from '../src/engines/descriptor.ts';
import { strandsRuntimeStamp } from '../src/engines/strands/index.ts';
import { tempPaths } from './helpers.ts';

describe('Strands runtime stamp', () => {
  it('reads package versions and the trimmed Hugging Face main revision', () => {
    const paths = tempPaths();
    const site = join(paths.venvs, 'strands-decider', 'lib', 'python3.12', 'site-packages');
    mkdirSync(site, { recursive: true });
    mkdirSync(join(site, 'strands_decider-1.2.3.dist-info'));
    mkdirSync(join(site, 'torch-2.7.0.dist-info'));
    const cache = join(paths.data, 'hf');
    const refs = join(cache, 'models--StrandsAgents--strands-decider-2B-qwen3.5-v1-2610', 'refs');
    mkdirSync(refs, { recursive: true });
    writeFileSync(join(refs, 'main'), '  abc123\n');
    const ctx = {
      paths,
      env: { HF_HUB_CACHE: cache },
      host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 1 },
    } as EngineContext;
    assert.deepEqual(strandsRuntimeStamp('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610', ctx), {
      runtime: 'strands-decider 1.2.3, torch 2.7.0',
      model: 'abc123',
    });
  });

  it('stamps strands-decider alone when torch is absent, and nothing without strands-decider', () => {
    const cases: readonly [string, string | null][] = [
      ['strands_decider-0.4.0.dist-info', 'strands-decider 0.4.0'],
      ['torch-2.7.0.dist-info', null],
    ];
    for (const [distInfo, runtime] of cases) {
      const paths = tempPaths();
      const site = join(paths.venvs, 'strands-decider', 'lib', 'python3.12', 'site-packages');
      mkdirSync(join(site, distInfo), { recursive: true });
      const ctx = {
        paths,
        env: { HF_HUB_CACHE: join(paths.data, 'hf') },
        host: { platform: 'linux', arch: 'x64', totalMemoryBytes: 1 },
      } as EngineContext;
      assert.equal(strandsRuntimeStamp('StrandsAgents/any', ctx).runtime, runtime);
    }
  });
});
