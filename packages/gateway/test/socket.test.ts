import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

/** Leaves a socket file at the gateway path with nothing listening, as a crashed gateway does. */
async function staleSocket(run: string): Promise<string> {
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const path = gatewaySocketPath(run);
  assert.ok(path !== null);
  const stale = createServer();
  servers.push(stale);
  await listen(stale, path);
  const displaced = join(run, 'stale.sock');
  renameSync(path, displaced);
  await close(stale);
  renameSync(displaced, path);
  assert.equal(existsSync(path), true);
  return path;
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
    const umaskBefore = process.umask();
    process.umask(umaskBefore);
    const gateway = await startGateway({
      config: testConfig(),
      paths: runtime,
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(gateway);
    const umaskAfter = process.umask();
    process.umask(umaskAfter);
    assert.equal(umaskAfter, umaskBefore);
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

  it('takes over a stale socket whose path is at the length limit', async () => {
    // The takeover renames the stale socket and connects to the new name, which must fit
    // sun_path too (104 bytes on macOS, where tmpdir paths are long).
    const paths = trackPaths(tempPaths());
    const prefix = Buffer.byteLength(join(paths.data, 'r', 'gateway.sock'));
    const run = join(paths.data, 'r'.repeat(1 + 100 - prefix));
    assert.equal(Buffer.byteLength(join(run, 'gateway.sock')), 100);
    const path = await staleSocket(run);
    const gateway = await startGateway({
      config: testConfig(),
      paths: { ...paths, run },
      engine: new FakeEngine(),
      env: {},
    });
    gateways.push(gateway);
    const response = await socketFetch(path)('http://localhost/health');
    assert.equal(response.status, 200);
  });

  it('takes over a stale refused socket and refuses a live socket', async () => {
    const stalePaths = trackPaths(tempPaths());
    const stalePath = await staleSocket(stalePaths.run);
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

  it('two concurrent ensures on an empty data dir spawn one gateway and both harnesses share it', async () => {
    const runtime = trackPaths(tempPaths());
    const config = testConfig();
    let spawns = 0;
    const started: Promise<unknown>[] = [];
    const fakeSpawn = (() => {
      spawns++;
      started.push(
        startGateway({ config, paths: runtime, engine: new FakeEngine(), env: {} }).then(
          (gateway) => gateways.push(gateway),
          () => undefined,
        ),
      );
      return Object.assign(new EventEmitter(), { unref() {}, pid: process.pid });
    }) as unknown as NonNullable<NonNullable<Parameters<typeof ensureGateway>[0]['deps']>['spawn']>;
    const deps = { manager: 'pidfile' as const, installed: () => false, spawn: fakeSpawn };
    const outcomes = await Promise.all([
      ensureGateway({ paths: runtime, config, deps }),
      ensureGateway({ paths: runtime, config, deps }),
    ]);
    await Promise.all(started);
    assert.equal(spawns, 1);
    assert.deepEqual(outcomes.map((outcome) => outcome.listener).toSorted(), [
      'running',
      'started',
    ]);
    const path = gatewaySocketPath(runtime.run);
    assert.ok(path !== null);
    const fetcher = socketFetch(path);
    const healths = await Promise.all(
      ['claude-hooks/3.0.0', 'paseo/3.1.1'].map(async (clientId) => {
        const response = await fetcher('http://localhost/health', {
          headers: { 'x-local-decider-client': clientId },
        });
        return (await response.json()) as { instance: string };
      }),
    );
    const body = (await (await fetcher('http://localhost/v1/status')).json()) as {
      instance: string;
      clients: Record<string, unknown>;
    };
    assert.ok(body.instance !== '');
    for (const health of healths) assert.equal(health.instance, body.instance);
    assert.ok('claude-hooks' in body.clients);
    assert.ok('paseo' in body.clients);
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
