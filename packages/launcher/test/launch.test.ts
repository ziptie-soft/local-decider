import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { isLoopbackUrl, launchGateway, type ExecFile } from '../src/launch.ts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ld-launcher-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function options(root: string, env: NodeJS.ProcessEnv = {}): Parameters<typeof launchGateway>[0] {
  return {
    url: 'http://127.0.0.1:8766',
    env: { ...env, LOCAL_DECIDER_HOME: join(root, 'data') },
    pinnedVersion: '3.2.0',
    guideUrl: 'https://example.test/install.ai.md',
  };
}

describe('launchGateway', () => {
  it('recognizes only loopback gateway URLs', () => {
    assert.equal(isLoopbackUrl('http://127.33.1.2:8766'), true);
    assert.equal(isLoopbackUrl('http://localhost:8766'), true);
    assert.equal(isLoopbackUrl('http://[::1]:8766'), true);
    assert.equal(isLoopbackUrl('https://example.test'), false);
    assert.equal(isLoopbackUrl('not a URL'), false);
  });

  it('returns disabled without probing when auto-start is disabled', async () => {
    const root = tempRoot();
    let calls = 0;
    const result = await launchGateway({
      ...options(root, { LOCAL_DECIDER_AUTOSTART: 'OFF' }),
      deps: {
        fetch: async () => {
          calls++;
          throw new Error('unexpected');
        },
      },
    });
    assert.equal(result.status, 'disabled');
    assert.equal(calls, 0);
    const data = join(root, 'data');
    assert.match(readFileSync(join(data, 'logs', 'launcher.log'), 'utf8'), /disabled/);
  });

  it('returns remote without probing and logs the skipped attempt', async () => {
    const root = tempRoot();
    let calls = 0;
    const result = await launchGateway({
      ...options(root),
      url: 'https://gateway.example.test',
      deps: {
        fetch: async () => {
          calls++;
          throw new Error('unexpected');
        },
      },
    });
    assert.equal(result.status, 'remote');
    assert.equal(calls, 0);
    assert.match(readFileSync(join(root, 'data', 'logs', 'launcher.log'), 'utf8'), /remote/);
  });

  it('reports a down engine as unusable even when the listener is up', async () => {
    const result = await launchGateway({
      ...options(tempRoot()),
      deps: {
        fetch: async () =>
          new Response(JSON.stringify({ status: 'down', engineState: 'failed' }), { status: 503 }),
      },
    });
    assert.deepEqual(result, {
      ok: false,
      status: 'running',
      message: 'gateway is answering /health',
      engine: { status: 'down', engineState: 'failed', detail: null },
    });
  });

  it('runs gateway ensure with sanitized env, fixed argv and private cwd', async () => {
    const root = tempRoot();
    const cli = join(root, 'local-decider');
    mkdirSync(join(root, 'bin'));
    writeFileSync(cli, '#!/usr/bin/env node\n');
    const execCalls: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }[] = [];
    const exec: ExecFile = async (file, args, opts) => {
      execCalls.push({ file, args, cwd: opts.cwd, env: opts.env });
      return {
        stdout: JSON.stringify({
          listener: 'started',
          engine: { status: 'degraded', engineState: 'starting', detail: null },
          message: 'gateway started',
        }),
        stderr: '',
      };
    };
    const result = await launchGateway({
      ...options(root, {
        LOCAL_DECIDER_BIN: cli,
        NODE_OPTIONS: '--inspect',
        NODE_PATH: '/untrusted/modules',
        EXAMPLE: 'kept',
      }),
      deps: {
        nodeReleaseName: 'node',
        nodeVersion: '24.15.0',
        execPath: '/trusted/node',
        execFile: exec,
      },
    });
    assert.equal(result.status, 'started');
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.file, '/trusted/node');
    assert.deepEqual(execCalls[0]?.args, [
      cli,
      'gateway',
      'ensure',
      '--url',
      'http://127.0.0.1:8766',
      '--json',
    ]);
    assert.equal(execCalls[0]?.cwd, join(root, 'data', 'run'));
    assert.equal(execCalls[0]?.env['NODE_OPTIONS'], undefined);
    assert.equal(execCalls[0]?.env['NODE_PATH'], undefined);
    assert.equal(execCalls[0]?.env['EXAMPLE'], 'kept');
    assert.match(readFileSync(join(root, 'data', 'logs', 'launcher.log'), 'utf8'), /started/);
  });

  it('reports not installed with a manual fish-compatible command and guide', async () => {
    const result = await launchGateway(options(tempRoot()));
    assert.equal(result.status, 'not-installed');
    assert.equal(result.ok, false);
    assert.match(result.message, /npm install -g @ziptie-soft\/local-decider@3\.2\.0/);
    assert.match(result.message, /local-decider gateway start/);
    assert.equal(result.guideUrl, 'https://example.test/install.ai.md');
  });

  it('refuses an unsafe data directory without writing a launcher log', async () => {
    const root = tempRoot();
    const data = join(root, 'data');
    mkdirSync(data, { mode: 0o700 });
    chmodSync(data, 0o777);
    const result = await launchGateway({
      ...options(root),
      deps: {
        fetch: async () => {
          throw new Error('offline');
        },
      },
    });
    assert.equal(result.status, 'unsafe-path');
    assert.throws(() => readFileSync(join(data, 'logs', 'launcher.log')), { code: 'ENOENT' });
  });

  it('does not put URL credentials into gateway CLI argv', async () => {
    const root = tempRoot();
    const cli = join(root, 'local-decider');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    let invoked = false;
    const result = await launchGateway({
      ...options(root, { LOCAL_DECIDER_BIN: cli }),
      url: 'http://user:secret@127.0.0.1:8766/path?token=secret',
      deps: {
        nodeReleaseName: 'node',
        nodeVersion: '24.15.0',
        execPath: '/trusted/node',
        fetch: async () => {
          throw new Error('offline');
        },
        execFile: async () => {
          invoked = true;
          return { stdout: '', stderr: '' };
        },
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(invoked, false);
    assert.ok(!readFileSync(join(root, 'data', 'logs', 'launcher.log'), 'utf8').includes('secret'));
  });

  it('maps ensure JSON even when its documented failure exit code is nonzero', async () => {
    const root = tempRoot();
    const cli = join(root, 'local-decider');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    const result = await launchGateway({
      ...options(root, { LOCAL_DECIDER_BIN: cli }),
      deps: {
        nodeReleaseName: 'node',
        nodeVersion: '24.15.0',
        execPath: '/trusted/node',
        fetch: async () => {
          throw new Error('offline');
        },
        execFile: async () => ({
          stdout: JSON.stringify({
            listener: 'port-busy',
            engine: null,
            message: 'port is occupied',
          }),
          stderr: '',
          error: Object.assign(new Error('exit 3'), { code: 3 }),
        }),
      },
    });
    assert.equal(result.status, 'port-busy');
    assert.equal(result.message, 'port is occupied');
    assert.equal(result.ok, false);
  });

  it('fails closed when registry metadata shows a release younger than 72 hours', async () => {
    const root = tempRoot();
    const result = await launchGateway({
      ...options(root, { LOCAL_DECIDER_AUTOINSTALL: '1' }),
      deps: {
        now: () => Date.parse('2026-11-27T00:00:00Z'),
        nodeReleaseName: 'node',
        nodeVersion: '24.15.0',
        execPath: '/trusted/node',
        fetch: async () =>
          new Response(
            JSON.stringify({
              time: { '3.2.0': '2026-11-25T12:00:00Z' },
            }),
          ),
        execFile: async () => {
          throw new Error('npm must not run before the age gate');
        },
      },
    });
    assert.equal(result.status, 'too-new');
    assert.equal(result.guideUrl, 'https://example.test/install.ai.md');
  });

  it('installs an old pinned release with isolated npm arguments and environment', async () => {
    const root = tempRoot();
    const nodeDir = join(root, 'node-prefix', 'bin');
    const node = join(nodeDir, 'node');
    const npm = join(root, 'node-prefix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(join(root, 'node-prefix', 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(node, '');
    writeFileSync(npm, '');
    let stage = '';
    let npmArgs: readonly string[] = [];
    let npmEnv: NodeJS.ProcessEnv = {};
    const exec: ExecFile = async (_file, args, opts) => {
      if (args.length === 1 && args[0] === '--version') return { stdout: 'v24.15.0', stderr: '' };
      if (args[1] === 'install') {
        npmArgs = args;
        npmEnv = opts.env;
        stage = args[args.indexOf('--prefix') + 1] ?? '';
        const installed = join(stage, 'node_modules', '@ziptie-soft', 'local-decider');
        mkdirSync(join(installed, 'dist'), { recursive: true });
        writeFileSync(join(installed, 'package.json'), JSON.stringify({ version: '3.2.0' }));
        writeFileSync(join(installed, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify({ listener: 'started', engine: null, message: 'gateway started' }),
        stderr: '',
      };
    };
    const result = await launchGateway({
      ...options(root, {
        LOCAL_DECIDER_AUTOINSTALL: '1',
        LOCAL_DECIDER_TOKEN: 'secret-token',
        PATH: nodeDir,
      }),
      deps: {
        now: () => Date.parse('2026-11-27T00:00:00Z'),
        home: root,
        nodeReleaseName: 'electron',
        electronVersion: '40.0.0',
        execPath: '/untrusted/electron',
        execFile: exec,
        fetch: async () =>
          new Response(
            JSON.stringify({
              time: { '3.2.0': '2026-11-22T00:00:00Z' },
            }),
          ),
      },
    });
    assert.equal(result.status, 'started');
    assert.deepEqual(Object.keys(npmEnv).toSorted(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert.equal(npmEnv['PATH'], nodeDir);
    assert.equal(npmEnv['HOME'], join(stage, 'home'));
    assert.ok(npmArgs.includes('--ignore-scripts'));
    assert.ok(npmArgs.includes('--no-package-lock'));
    assert.ok(npmArgs.includes('--strict-ssl=true'));
    assert.ok(npmArgs.includes('@ziptie-soft/local-decider@3.2.0'));
    assert.ok(!npmArgs.includes('secret-token'));
    assert.throws(() => readFileSync(stage), { code: 'ENOENT' });
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            root,
            'data',
            'gateway',
            '3.2.0',
            'node_modules',
            '@ziptie-soft',
            'local-decider',
            'package.json',
          ),
          'utf8',
        ),
      ).version,
      '3.2.0',
    );
  });
});
