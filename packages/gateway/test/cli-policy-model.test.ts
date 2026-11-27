import { GatewayClient } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  parsePolicyFlags,
  parseUseCommand,
  runPolicyUse,
  type PolicyUseOutcome,
} from '../src/cli-policy-model.ts';
import { UsageError } from '../src/cli-support.ts';

const REFUSED = 'gateway refused: control token missing or wrong';

let server: Server;
let url = '';
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let seen: { method: string; path: string; body: unknown }[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: raw === '' ? null : JSON.parse(raw),
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen = [];
  reply = { status: 200, body: {} };
});

function use(args: string[], baseUrl = url): Promise<PolicyUseOutcome> {
  const command = parseUseCommand(args);
  assert.notEqual(command.kind, 'engine');
  if (command.kind === 'engine') {
    throw new Error('expected a policy command');
  }
  return runPolicyUse(new GatewayClient({ baseUrl, timeoutMs: 2000 }), command, {
    url: baseUrl,
    refused: REFUSED,
  });
}

describe('engine use flags', () => {
  it('keeps a plain engine use unchanged', () => {
    assert.deepEqual(parseUseCommand(['llama-vulkan', 'd3-lite-q8_0', '--device', 'vulkan0']), {
      kind: 'engine',
      engine: 'llama-vulkan',
      model: 'd3-lite-q8_0',
      device: 'vulkan0',
    });
  });

  it('parses --policy, --fallback and --device', () => {
    assert.deepEqual(
      parsePolicyFlags(['--policy', 'command-risk', '--fallback', 'open', 'a', 'b']),
      { policy: 'command-risk', fallback: 'open', positionals: ['a', 'b'] },
    );
  });

  it('exits 2 for --fallback without --policy', () => {
    assert.throws(
      () => parseUseCommand(['llama-vulkan', 'd3-lite-q8_0', '--fallback', 'open']),
      (error: unknown) =>
        error instanceof UsageError && /--fallback needs --policy/.test(error.message),
    );
  });

  it('exits 2 for an unknown --fallback value', () => {
    assert.throws(
      () =>
        parseUseCommand(['llama-vulkan', 'd3-lite-q8_0', '--policy', 'x', '--fallback', 'none']),
      (error: unknown) => error instanceof UsageError && /default or open/.test(error.message),
    );
  });

  it('exits 2 for default without --policy, or with flags that do not apply', () => {
    for (const args of [
      ['default'],
      ['default', '--policy', 'x', '--fallback', 'open'],
      ['default', '--policy', 'x', '--device', 'cpu'],
      ['default', 'model', '--policy', 'x', '--fallback', 'open'],
      ['llama-vulkan', '--policy', 'x'],
      ['a', 'b', 'c', '--policy', 'x'],
      ['--policy'],
    ]) {
      assert.throws(() => parseUseCommand(args), UsageError, args.join(' '));
    }
  });

  it('exits 2 for an empty or repeated --policy or --fallback', () => {
    for (const args of [
      ['a', 'b', '--policy', ''],
      ['a', 'b', '--policy='],
      ['a', 'b', '--policy', 'x', '--fallback', ''],
      ['a', 'b', '--policy', 'x', '--policy', 'y'],
      ['a', 'b', '--policy', 'x', '--fallback', 'open', '--fallback', 'default'],
    ]) {
      assert.throws(() => parseUseCommand(args), UsageError, args.join(' '));
    }
  });
});

describe('engine use exit status', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

  function runCli(
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const home = mkdtempSync(join(tmpdir(), 'ld-cli-'));
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--conditions=source', cli, 'engine', 'use', ...args],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            LOCAL_DECIDER_HOME: home,
            LOCAL_DECIDER_CONFIG_DIR: join(home, 'config'),
            LOCAL_DECIDER_URL: url,
          },
        },
        (error, stdout, stderr) => {
          rmSync(home, { recursive: true, force: true });
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  it('exits 2 for a usage error, without calling the gateway', async () => {
    const result = await runCli(['llama-vulkan', 'm', '--fallback', 'open']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--fallback needs --policy/);
    assert.deepEqual(seen, []);
  });

  it('exits 1 and prints the gateway text for a 409', async () => {
    const text = 'too many decisions with their own model (max 3)';
    reply = { status: 409, body: { error: text } };
    const result = await runCli(['llama-vulkan', 'm', '--policy', 'x']);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), text);
    assert.equal(seen[0]?.path, '/v1/policies/x/selection');
  });

  it('exits 0 for an accepted set whose model is unavailable', async () => {
    reply = { status: 200, body: { ok: true, status: 'unavailable', reason: 'no GPU' } };
    const result = await runCli(['llama-vulkan', 'm', '--policy', 'x', '--fallback', 'open']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /unavailable: no GPU; its decisions are skipped/);
  });
});

describe('engine use --policy', () => {
  it('posts {clear:true} for default --policy', async () => {
    reply = { status: 200, body: { ok: true, policy: 'x', selection: null, status: 'default' } };
    const outcome = await use(['default', '--policy', 'x']);
    assert.deepEqual(seen, [
      { method: 'POST', path: '/v1/policies/x/selection', body: { clear: true } },
    ]);
    assert.deepEqual(outcome, { ok: true, message: 'x now uses the default model.' });
  });

  it('posts the selection with its device and fallback', async () => {
    reply = {
      status: 200,
      body: {
        ok: true,
        policy: 'command-risk',
        selection: { engine: 'llama-vulkan', model: 'd3-lite-q8_0', fallback: 'open' },
        status: 'active',
      },
    };
    const outcome = await use([
      'llama-vulkan',
      'd3-lite-q8_0',
      '--policy',
      'command-risk',
      '--device',
      'vulkan0',
      '--fallback',
      'open',
    ]);
    assert.deepEqual(seen[0]?.body, {
      engine: 'llama-vulkan',
      model: 'd3-lite-q8_0',
      device: 'vulkan0',
      fallback: 'open',
    });
    assert.deepEqual(outcome, {
      ok: true,
      message: 'command-risk now uses llama-vulkan d3-lite-q8_0 (loads when first needed).',
    });
  });

  it('omits device and fallback when not given', async () => {
    reply = { status: 200, body: { ok: true, status: 'active' } };
    const outcome = await use(['llama-vulkan', 'd3-lite-q8_0', '--policy', 'command-risk']);
    assert.deepEqual(seen[0]?.body, { engine: 'llama-vulkan', model: 'd3-lite-q8_0' });
    assert.equal(
      outcome.message,
      'command-risk now uses llama-vulkan d3-lite-q8_0 (loads when first needed).',
    );
  });

  it('reports an unavailable or off model from the gateway status', async () => {
    reply = {
      status: 200,
      body: {
        ok: true,
        selection: { engine: 'llama-vulkan', model: 'm', fallback: 'default' },
        status: 'unavailable',
        reason: 'does not fit with the default model',
      },
    };
    assert.match(
      (await use(['llama-vulkan', 'm', '--policy', 'x'])).message,
      /unavailable: does not fit with the default model; the default model answers instead/,
    );
    reply = {
      status: 200,
      body: {
        ok: true,
        selection: { engine: 'llama-vulkan', model: 'm', fallback: 'open' },
        status: 'unavailable',
      },
    };
    assert.match(
      (await use(['llama-vulkan', 'm', '--policy', 'x'])).message,
      /decisions are skipped/,
    );
    reply = { status: 200, body: { ok: true, status: 'off' } };
    assert.match(
      (await use(['llama-vulkan', 'm', '--policy', 'x'])).message,
      /^x now uses llama-vulkan m\.$/,
    );
  });

  it('takes the fallback from the request when the response has no selection', async () => {
    reply = { status: 200, body: { ok: true, status: 'unavailable' } };
    assert.match(
      (await use(['llama-vulkan', 'm', '--policy', 'x', '--fallback', 'open'])).message,
      /decisions are skipped/,
    );
    assert.match(
      (await use(['llama-vulkan', 'm', '--policy', 'x'])).message,
      /the default model answers instead/,
    );
  });

  it('prints a 409 error as the gateway sent it', async () => {
    reply = { status: 409, body: { error: 'engine switch in progress' } };
    assert.deepEqual(await use(['llama-vulkan', 'm', '--policy', 'x']), {
      ok: false,
      message: 'engine switch in progress',
    });
  });

  it('prints the body of an error without a message', async () => {
    reply = { status: 400, body: { oops: true } };
    assert.deepEqual(await use(['default', '--policy', 'x']), {
      ok: false,
      message: '{"oops":true}',
    });
  });

  it('prints a missing token like the other auth errors', async () => {
    reply = { status: 401, body: { error: 'unauthorised' } };
    assert.deepEqual(await use(['default', '--policy', 'x']), { ok: false, message: REFUSED });
  });

  it('says so when the gateway is unreachable', async () => {
    const outcome = await use(['default', '--policy', 'x'], 'http://127.0.0.1:1');
    assert.deepEqual(outcome, { ok: false, message: 'gateway unreachable at http://127.0.0.1:1' });
  });
});
