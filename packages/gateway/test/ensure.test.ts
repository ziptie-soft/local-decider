import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';

import { parseConfig, type GatewayConfig } from '../src/config.ts';
import { ensureExitCode, ensureGateway } from '../src/ensure.ts';
import { gatewayWasStopped, stopService } from '../src/service.ts';
import { tempPaths } from './helpers.ts';

function config(port: number): GatewayConfig {
  return parseConfig({ port, host: '127.0.0.1' });
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function healthy(status = 'degraded'): Response {
  return new Response(JSON.stringify({ status, engineState: 'starting', detail: 'loading' }));
}

function fakeChild(onUnref?: (child: EventEmitter) => void): ChildProcess {
  const child = new EventEmitter();
  Object.assign(child, { unref: () => onUnref?.(child) });
  return child as unknown as ChildProcess;
}

describe('gateway ensure', () => {
  it('reports a healthy listener and keeps engine readiness separate', async () => {
    const paths = tempPaths();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await ensureGateway({
        paths,
        config: config(port),
        deps: {
          fetch: async () => healthy(),
          manager: 'pidfile',
          installed: () => false,
          spawn: () => {
            throw new Error('must not spawn');
          },
        },
      });
      assert.equal(result.listener, 'running');
      assert.deepEqual(result.engine, {
        status: 'degraded',
        engineState: 'starting',
        detail: 'loading',
      });
      assert.equal(ensureExitCode(result), 0);
    } finally {
      server.close();
    }
  });

  it('refuses remote and mismatched endpoints before starting anything', async () => {
    const paths = tempPaths();
    const port = await ephemeralPort();
    const remote = await ensureGateway({
      paths,
      config: config(port),
      url: 'https://example.test',
    });
    const mismatch = await ensureGateway({
      paths,
      config: config(port),
      url: `http://127.0.0.1:${String(port + 1)}`,
    });
    assert.equal(remote.listener, 'remote');
    assert.equal(mismatch.listener, 'mismatch');
    assert.equal(ensureExitCode(remote), 2);
    const ipv6 = await ensureGateway({
      paths,
      config: parseConfig({ host: '::1', port }),
      url: `http://[::1]:${String(port)}`,
      deps: { fetch: async () => healthy(), manager: 'pidfile' },
    });
    assert.equal(ipv6.listener, 'running');
  });

  it('prints JSON and the documented exit code from the CLI for a remote URL', () => {
    const paths = tempPaths();
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const child = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        cli,
        'gateway',
        'ensure',
        '--url',
        'https://example.invalid',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: paths.data,
          XDG_CONFIG_HOME: paths.data,
          XDG_DATA_HOME: paths.data,
          LOCAL_DECIDER_HOME: paths.data,
          LOCAL_DECIDER_CONFIG_DIR: paths.config,
        },
      },
    );
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).listener, 'remote');
  });

  it('respects stop marker unless --force is set', async () => {
    const paths = tempPaths();
    stopService('pidfile', paths);
    assert.equal(gatewayWasStopped(paths), true);
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      force: false,
      deps: { fetch: async () => new Response('{}', { status: 503 }) },
    });
    assert.equal(result.listener, 'stopped');

    let launched = false;
    const forced = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      force: true,
      timeoutSeconds: 0,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => new Response('{}', { status: 503 }),
        portOpen: async () => false,
        spawn: (() => {
          launched = true;
          return fakeChild();
        }) as never,
      },
    });
    assert.equal(forced.listener, 'failed');
    assert.equal(launched, true);
    assert.equal(gatewayWasStopped(paths), false);
  });

  it('reports a healthy gateway even when the stop marker exists', async () => {
    const paths = tempPaths();
    stopService('pidfile', paths);
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      deps: {
        fetch: async () => healthy('ok'),
        manager: 'pidfile',
        spawn: () => {
          throw new Error('must not spawn');
        },
      },
    });
    assert.equal(result.listener, 'running');
    assert.equal(gatewayWasStopped(paths), true);
  });

  it('reports an asynchronous spawn error without waiting for the health timeout', async () => {
    const paths = tempPaths();
    let probes = 0;
    let errorListenerBeforeUnref = false;
    const startedAt = Date.now();
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 10,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => {
          probes += 1;
          return probes < 3 ? new Response('{}', { status: 503 }) : new Promise<Response>(() => {});
        },
        portOpen: async () => false,
        spawn: (() =>
          fakeChild((child) => {
            errorListenerBeforeUnref = child.listenerCount('error') === 1;
            queueMicrotask(() => child.emit('error', new Error('spawn EACCES')));
          })) as never,
      },
    });
    assert.equal(result.listener, 'failed');
    assert.equal(result.message, 'spawn EACCES');
    assert.equal(errorListenerBeforeUnref, true);
    assert.ok(Date.now() - startedAt < 1000);
  });

  it('reports a child exit before health with the gateway log path', async () => {
    const paths = tempPaths();
    let probes = 0;
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 10,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => {
          probes += 1;
          return probes < 3 ? new Response('{}', { status: 503 }) : new Promise<Response>(() => {});
        },
        portOpen: async () => false,
        spawn: (() =>
          fakeChild((child) => queueMicrotask(() => child.emit('exit', 1, null)))) as never,
      },
    });
    assert.equal(result.listener, 'failed');
    assert.match(result.message, /gateway exited before \/health answered \(code 1\)/);
    assert.match(result.message, /gateway\.log/);
  });

  it('starts one detached process with isolated Node flags and a private log', async () => {
    const paths = tempPaths();
    let probes = 0;
    let spawnArgs: readonly string[] = [];
    let spawnOptions: Record<string, unknown> = {};
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 1,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => (++probes >= 3 ? healthy('down') : new Response('{}', { status: 503 })),
        portOpen: async () => false,
        execPath: '/trusted/node',
        execArgv: ['--conditions=source', '--inspect=1'],
        script: '/app/cli.js',
        env: { NODE_OPTIONS: '--require evil', NODE_PATH: '/bad', KEEP: 'yes' },
        spawn: ((_command: string, args: readonly string[] = [], options?: SpawnOptions) => {
          spawnArgs = args;
          spawnOptions = options as Record<string, unknown>;
          return fakeChild();
        }) as never,
      },
    });
    assert.equal(result.listener, 'started');
    assert.deepEqual(spawnArgs, ['--conditions=source', '/app/cli.js', 'gateway', 'run']);
    assert.equal(spawnOptions['cwd'], paths.run);
    assert.equal((spawnOptions['env'] as Record<string, string>)['NODE_OPTIONS'], undefined);
    assert.equal((spawnOptions['env'] as Record<string, string>)['NODE_PATH'], undefined);
    assert.equal(statSync(`${paths.logs}/gateway.log`).mode & 0o777, 0o600);
  });

  it('starts an installed service without spawning a pidfile process', async () => {
    const paths = tempPaths();
    let starts = 0;
    const result = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 1,
      deps: {
        manager: 'systemd',
        installed: () => true,
        startService: () => {
          starts += 1;
        },
        fetch: async () => (starts > 0 ? healthy('ok') : new Response('{}', { status: 503 })),
      },
    });
    assert.equal(result.listener, 'service-started');
    assert.equal(starts, 1);
  });

  it('reports a busy port and repairs writable owned paths without launching', async () => {
    const paths = tempPaths();
    const busy = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 0,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => new Response('{}', { status: 503 }),
        portOpen: async () => true,
        spawn: () => {
          throw new Error('must not spawn');
        },
      },
    });
    assert.equal(busy.listener, 'port-busy');
    assert.equal(ensureExitCode(busy), 3);

    chmodSync(paths.data, 0o770);
    const repaired = await ensureGateway({
      paths,
      config: config(await ephemeralPort()),
      timeoutSeconds: 0,
      deps: {
        manager: 'pidfile',
        installed: () => false,
        fetch: async () => new Response('{}', { status: 503 }),
        portOpen: async () => true,
        spawn: () => {
          throw new Error('must not spawn');
        },
      },
    });
    assert.equal(repaired.listener, 'port-busy');
    assert.equal(statSync(paths.data).mode & 0o777, 0o700);
  });
});
