import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ensureExitCode, ensureGateway } from '../src/ensure.ts';
import { startGateway } from '../src/runtime.ts';
import { gatewaySocketPath } from '../src/socket-path.ts';
import { socketFetch } from '../src/socket-transport.ts';
import { FakeEngine, tempPaths, testConfig } from './helpers.ts';

const gateways: Awaited<ReturnType<typeof startGateway>>[] = [];
const servers: Server[] = [];
const roots: string[] = [];

function trackPaths(value: ReturnType<typeof tempPaths>): ReturnType<typeof tempPaths> {
  roots.push(value.data);
  return value;
}

async function listen(server: Server, address: string | number, host?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof address === 'number') server.listen(address, host, resolve);
    else server.listen(address, resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(servers.splice(0).map(close));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('gateway Unix socket', () => {
  it('serves health over a mode-0600 socket and removes only its socket on close', async () => {
    const runtime = trackPaths(tempPaths());
    const gateway = await startGateway({
      config: testConfig(),
      paths: runtime,
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(gateway);
    const path = gatewaySocketPath(runtime.run);
    assert.ok(path !== null);
    const socketStat = statSync(path);
    assert.equal(socketStat.mode & 0o777, 0o600);
    const response = await socketFetch(path)('http://localhost/health', {
      headers: { 'x-local-decider-client': 'test/1.0.0' },
    });
    const health = (await response.json()) as Record<string, unknown>;
    assert.equal(health['version'] !== undefined, true);
    assert.match(String(health['instance']), /^[0-9a-f-]{36}$/i);
    await gateway.close();
    gateways.splice(gateways.indexOf(gateway), 1);
    assert.equal(existsSync(path), false);
  });

  it('takes over a stale refused socket and refuses a live socket', async () => {
    const stalePaths = trackPaths(tempPaths());
    mkdirSync(stalePaths.run, { recursive: true, mode: 0o700 });
    const stalePath = gatewaySocketPath(stalePaths.run);
    assert.ok(stalePath !== null);
    const stale = createServer();
    servers.push(stale);
    await listen(stale, stalePath);
    const displacedPath = join(stalePaths.run, 'stale.sock');
    renameSync(stalePath, displacedPath);
    await close(stale);
    renameSync(displacedPath, stalePath);
    assert.equal(existsSync(stalePath), true);
    const recovered = await startGateway({
      config: testConfig(),
      paths: stalePaths,
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(recovered);
    assert.ok(existsSync(stalePath));

    const livePaths = trackPaths(tempPaths());
    mkdirSync(livePaths.run, { recursive: true, mode: 0o700 });
    const livePath = gatewaySocketPath(livePaths.run);
    assert.ok(livePath !== null);
    const live = createServer((_req, res) => res.end('{"status":"ok"}'));
    servers.push(live);
    await listen(live, livePath);
    await assert.rejects(
      startGateway({
        config: testConfig(),
        paths: livePaths,
        engine: new FakeEngine(),
        env: {},
      }),
      { code: 'EADDRINUSE' },
    );
  });

  it('validates client identities and exposes a bounded client map', async () => {
    const runtime = trackPaths(tempPaths());
    const gateway = await startGateway({
      config: testConfig(),
      paths: runtime,
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(gateway);
    const path = gatewaySocketPath(runtime.run);
    assert.ok(path !== null);
    const fetcher = socketFetch(path);
    for (let index = 0; index < 34; index++) {
      await fetcher('http://localhost/health', {
        headers: { 'x-local-decider-client': `harness-${String(index)}/1.0.0` },
      });
    }
    await fetcher('http://localhost/health', {
      headers: { 'x-local-decider-client': 'bad harness/1.0.0' },
    });
    await fetcher('http://localhost/health', {
      headers: { 'x-local-decider-client': `${'x'.repeat(60)}/1.0.0` },
    });
    await fetcher('http://localhost/health', {
      headers: { 'x-local-decider-client': 'harness-33/1.0.0' },
    });
    const status = (await (await fetcher('http://localhost/v1/status')).json()) as {
      clients: Record<
        string,
        { version: string; firstSeen: number; lastSeen: number; requests: number }
      >;
    };
    assert.equal(Object.keys(status.clients).length, 32);
    assert.equal('harness-0' in status.clients, false);
    assert.equal('bad harness' in status.clients, false);
    assert.equal(status.clients['harness-33']?.version, '1.0.0');
    assert.equal(status.clients['harness-33']?.requests, 2);
  });

  it('runs two concurrent ensure calls against one gateway and records both harnesses', async () => {
    const runtime = trackPaths(tempPaths());
    const config = testConfig();
    const gateway = await startGateway({
      config,
      paths: runtime,
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(gateway);
    let spawns = 0;
    const deps = {
      manager: 'pidfile' as const,
      installed: () => false,
      spawn: () => {
        spawns++;
        throw new Error('the live socket should prevent spawning');
      },
    };
    const outcomes = await Promise.all([
      ensureGateway({ paths: runtime, config, deps }),
      ensureGateway({ paths: runtime, config, deps }),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.listener),
      ['running', 'running'],
    );
    assert.equal(spawns, 0);
    const path = gatewaySocketPath(runtime.run);
    assert.ok(path !== null);
    const fetcher = socketFetch(path);
    await Promise.all(
      ['claude-hooks/1.0.0', 'paseo/3.1.1'].map((clientId) =>
        fetcher('http://localhost/health', {
          headers: { 'x-local-decider-client': clientId },
        }),
      ),
    );
    const body = (await (await fetcher('http://localhost/v1/status')).json()) as {
      instance: string;
      clients: Record<string, unknown>;
    };
    assert.equal(body.instance !== '', true);
    assert.deepEqual(Object.keys(body.clients).toSorted(), ['claude-hooks', 'cli', 'paseo']);
    assert.equal(new Set([process.pid]).size, 1);
  });

  it('detects an older TCP gateway without starting another process', async () => {
    const runtime = trackPaths(tempPaths());
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    servers.push(server);
    await listen(server, 0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    let spawned = false;
    const outcome = await ensureGateway({
      paths: runtime,
      config: { ...testConfig(), port },
      deps: {
        manager: 'pidfile',
        installed: () => false,
        spawn: () => {
          spawned = true;
          throw new Error('unexpected');
        },
      },
    });
    assert.equal(outcome.listener, 'legacy');
    assert.equal(ensureExitCode(outcome), 2);
    assert.equal(
      outcome.message,
      `an older gateway runs on :${String(port)} without a socket; run \`local-decider gateway restart\``,
    );
    assert.equal(spawned, false);
  });

  it('uses TCP when the shared socket path rule disables a long path', async () => {
    const runtime = trackPaths(tempPaths());
    const longPaths = { ...runtime, run: join(runtime.data, 'r'.repeat(100)) };
    const logs: string[] = [];
    const gateway = await startGateway({
      config: testConfig(),
      paths: longPaths,
      engine: new FakeEngine(),
      env: {},
      log: (line) => logs.push(line),
    });
    gateways.push(gateway);
    assert.equal(gatewaySocketPath(longPaths.run), null);
    assert.equal(logs.filter((line) => line.includes('socket path exceeds')).length, 1);
    assert.equal((await fetch(`${gateway.url}/health`)).status, 200);
  });
});
