import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseConfig } from '../../src/config.ts';
import {
  ENGINE_ENV_ALLOW,
  engineChildEnv,
  setSecretEnvNames,
  configTokenEnvNames,
} from '../../src/engines/child-env.ts';
import { killChild, trackChild, trackedChildCount } from '../../src/engines/child-reaper.ts';
import { engineSchema, engineOptionsSchema } from '../../src/engines/registry.ts';
import { RESERVED_SERVE_FLAGS } from '../../src/engines/strands/extra-args.ts';
import { SupervisedEngine, type ServerSpec } from '../../src/engines/supervised.ts';
import { tempPaths } from '../helpers.ts';

function spec(path: string, env?: Record<string, string>): ServerSpec {
  return {
    id: 'hygiene',
    model: 'm',
    startTimeoutSeconds: 10,
    healthPath: '/health',
    binary: () => ({ path }),
    args: () => [],
    ...(env === undefined ? {} : { env }),
  };
}

const allowed = (name: string): boolean => ENGINE_ENV_ALLOW.some((p) => p.test(name));
const count = (): number => process.listenerCount('exit');
const parse = (extraArgs: string[]): ReturnType<typeof parseConfig> =>
  parseConfig({ port: 0, engine: { type: 'strands-decider', extraArgs } });

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await sleep(50);
  }
  assert.ok(check(), 'condition not reached');
}

describe('engine child environment', () => {
  it('passes only allowlisted names plus the spec env', () => {
    setSecretEnvNames([]);
    const env = engineChildEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        LC_ALL: 'C',
        XDG_DATA_HOME: '/x',
        HF_HUB_CACHE: '/hf',
        TORCH_HOME: '/t',
        PYTHONUNBUFFERED: '1',
        PYTHONSTARTUP: '/evil.py',
        PYTHONPATH: '/evil',
        HIP_VISIBLE_DEVICES: '0',
        LD_LIBRARY_PATH: '/lib',
        GGML_VK_VISIBLE_DEVICES: '0',
        LOCAL_DECIDER_TOKEN: 'bearer',
        AWS_SECRET_ACCESS_KEY: 'nope',
        GITHUB_TOKEN: 'nope',
      },
      { SPEC: 'yes' },
    );
    assert.deepEqual(Object.keys(env).toSorted(), [
      'GGML_VK_VISIBLE_DEVICES',
      'HF_HUB_CACHE',
      'HIP_VISIBLE_DEVICES',
      'HOME',
      'LC_ALL',
      'LD_LIBRARY_PATH',
      'PATH',
      'PYTHONUNBUFFERED',
      'SPEC',
      'TORCH_HOME',
      'XDG_DATA_HOME',
    ]);
  });

  it('never allows the interpreter hooks or gateway secrets by pattern', () => {
    assert.ok(allowed('PYTHONHASHSEED'));
    assert.ok(!allowed('PYTHONSTARTUP') && !allowed('PYTHONPATH'));
    assert.ok(!allowed('LOCAL_DECIDER_REPORT_TOKEN') && !allowed('SSH_AUTH_SOCK'));
  });

  it('passes proxy, CA bundle and ROCm variables', () => {
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'no_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      assert.ok(allowed(name), name);
    }
    for (const name of ['REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HSA_OVERRIDE_GFX_VERSION']) {
      assert.ok(allowed(name), name);
    }
    assert.ok(!allowed('SSL_KEY_PASSWORD') && !allowed('PROXY_TOKEN'));
  });

  it('withholds tokenEnv names even when they match an allowed prefix', () => {
    const config = {
      engine: { tokenEnv: 'HF_SECRET' },
      engines: { a: { tokenEnv: 'CUDA_KEY' } },
      discovery: [{ tokenEnv: '' }],
    };
    assert.deepEqual(configTokenEnvNames(config), ['HF_SECRET', 'CUDA_KEY']);
    setSecretEnvNames(configTokenEnvNames(config));
    const env = engineChildEnv({ HF_SECRET: 's', CUDA_KEY: 's', HF_HOME: '/hf' }, undefined);
    assert.deepEqual(env, { HF_HOME: '/hf' });
    setSecretEnvNames([]);
  });

  it('spawns the engine with the filtered env', async () => {
    process.env['LD_HYGIENE_SECRET'] = 'leak';
    setSecretEnvNames([]);
    const paths = tempPaths();
    const out = join(paths.data, 'env.txt');
    const script = join(paths.data, 'engine.sh');
    writeFileSync(script, `#!/bin/sh\nenv > ${out}\nsleep 30\n`);
    chmodSync(script, 0o755);
    const engine = new SupervisedEngine(spec(script, { SPEC_ONLY: '1' }), paths);
    void engine.start();
    try {
      await until(() => existsSync(out) && readFileSync(out, 'utf8').includes('SPEC_ONLY'));
      const text = readFileSync(out, 'utf8');
      assert.ok(!text.includes('LD_HYGIENE_SECRET'));
      assert.match(text, /SPEC_ONLY=1/);
    } finally {
      delete process.env['LD_HYGIENE_SECRET'];
      await engine.stop();
    }
  });
});

describe('spawn failures', () => {
  it('marks the engine failed on EACCES without throwing', async () => {
    const paths = tempPaths();
    const script = join(paths.data, 'not-executable');
    writeFileSync(script, '#!/bin/sh\n');
    chmodSync(script, 0o644);
    const engine = new SupervisedEngine(spec(script), paths);
    await engine.start();
    await until(() => engine.health().state === 'failed');
    assert.match(engine.health().detail ?? '', /failed to start.*EACCES/);
    await engine.stop();
  });
});

describe('child reaper', () => {
  it('tracks a child until exit and kills its whole process group', async () => {
    const before = trackedChildCount();
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    trackChild(child);
    assert.equal(trackedChildCount(), before + 1);
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killChild(child, 'SIGTERM');
    await exited;
    assert.equal(trackedChildCount(), before);
    await until(() => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('installs the process handlers once', () => {
    const child = spawn('sh', ['-c', 'exit 0'], { detached: true });
    trackChild(child);
    const first = count();
    const second = spawn('sh', ['-c', 'exit 0'], { detached: true });
    trackChild(second);
    assert.equal(count(), first);
  });
});

describe('strands extraArgs', () => {
  it('accepts harmless flags', () => {
    assert.deepEqual(parse(['--no-warmup', '--dtype=bfloat16']).engine.type, 'strands-decider');
  });

  for (const flag of RESERVED_SERVE_FLAGS) {
    it(`rejects ${flag} in both forms and its bare value`, () => {
      assert.throws(() => parse([flag, '0.0.0.0']), /cannot go in extraArgs/);
      assert.throws(() => parse([`${flag}=0.0.0.0`]), /cannot go in extraArgs/);
    });
  }

  it('flags the value after a reserved flag', () => {
    assert.throws(() => parse(['--port', '9999']), /value of --port/);
  });

  it('still builds the registry schemas', () => {
    assert.equal(
      engineSchema.safeParse({ type: 'strands-decider', extraArgs: ['--host=0.0.0.0'] }).success,
      false,
    );
    assert.equal(
      engineOptionsSchema.safeParse({ 'strands-decider': { extraArgs: ['--port', '1'] } }).success,
      false,
    );
    assert.equal(
      engineOptionsSchema.safeParse({ 'strands-decider': { extraArgs: ['--no-warmup'] } }).success,
      true,
    );
  });
});
