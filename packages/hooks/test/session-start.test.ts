import type { GatewayHealth } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEvent } from '../src/mapping.ts';
import { run, type Env } from '../src/run.ts';
import { printable, type Health } from '../src/session-start.ts';

const STDIN = JSON.stringify({ session_id: 's-1', cwd: '/work', source: 'startup' });

async function start(health: Health, env: Env = {}, harness = 'claude'): Promise<string> {
  const res = await run(harness, 'SessionStart', STDIN, env, {
    health,
    decide: async () => {
      throw new Error('SessionStart must not run a policy');
    },
  });
  assert.equal(res.exitCode, 0);
  return res.stdout;
}

const answer =
  (value: GatewayHealth | null): Health =>
  async () =>
    value;

function systemMessage(stdout: string): string {
  const parsed = JSON.parse(stdout) as { systemMessage?: unknown };
  assert.deepEqual(Object.keys(parsed), ['systemMessage']);
  assert.equal(typeof parsed.systemMessage, 'string');
  return parsed.systemMessage as string;
}

describe('SessionStart', () => {
  it('is a known event', () => {
    assert.equal(parseEvent('SessionStart'), 'SessionStart');
    assert.equal(parseEvent('session-start'), 'SessionStart');
  });

  it('warns when the gateway is unreachable', async () => {
    const msg = systemMessage(await start(answer(null)));
    assert.equal(
      msg,
      'local-decider: gateway at http://127.0.0.1:8765 is not reachable; only the built-in command guard is active',
    );
  });

  it('reports a down gateway with its detail', async () => {
    const health = answer({ status: 'down', engineState: 'failed', detail: 'model not found' });
    const msg = systemMessage(await start(health, { LOCAL_DECIDER_URL: 'http://127.0.0.1:9000/' }));
    assert.equal(msg, 'local-decider: gateway at http://127.0.0.1:9000 is down: model not found');
  });

  it('falls back to the engine state, then to the status alone', async () => {
    assert.match(
      systemMessage(await start(answer({ status: 'degraded', engineState: 'starting' }))),
      /is degraded: starting$/,
    );
    assert.match(systemMessage(await start(answer({ status: 'down' }))), /is down$/);
  });

  it('sanitizes the detail to one printable ASCII line of at most 120 characters', async () => {
    const detail = `bad\u001b[31m\nlineé‮ ${'x'.repeat(300)}`;
    const msg = systemMessage(await start(answer({ status: 'down', detail })));
    const shown = msg.split('is down: ')[1] ?? '';
    assert.ok(shown.length <= 120, `detail too long: ${String(shown.length)}`);
    assert.match(shown, /^[\x20-\x7e]+$/);
    assert.ok(shown.startsWith('bad [31m line x'));
    assert.equal(printable('\u0000\u0007', 120), '');
  });

  it('prints nothing when the gateway is ok', async () => {
    assert.equal(await start(answer({ status: 'ok', engine: 'llama', model: 'm' })), '');
  });

  it('never prints the token, userinfo or path of the gateway URL', async () => {
    const env = {
      LOCAL_DECIDER_URL: 'https://alice:hunter2@gw.example.com:8443/base?token=q#f',
      LOCAL_DECIDER_TOKEN: 'sekrit-token',
    };
    for (const health of [answer(null), answer({ status: 'down', detail: 'engine failed' })]) {
      const out = await start(health, env);
      assert.match(systemMessage(out), /gateway at https:\/\/gw\.example\.com:8443 is /);
      for (const secret of ['alice', 'hunter2', 'sekrit-token', '/base', 'token=q']) {
        assert.ok(!out.includes(secret), `printed ${secret}`);
      }
    }
  });

  it('names an invalid URL without echoing it', async () => {
    const out = await start(answer(null), { LOCAL_DECIDER_URL: 'not a url sekrit' });
    assert.match(systemMessage(out), /gateway at an invalid URL is not reachable/);
    assert.ok(!out.includes('sekrit'));
  });

  it('prints nothing for Codex', async () => {
    let asked = false;
    const health: Health = async () => {
      asked = true;
      return null;
    };
    assert.equal(await start(health, {}, 'codex'), '');
    assert.equal(asked, false);
  });

  it('fails open when the health check throws or answers garbage', async () => {
    assert.equal(
      await start(async () => {
        throw new Error('boom');
      }),
      '',
    );
    const garbage = (async () => 'nope') as unknown as Health;
    assert.match(systemMessage(await start(garbage)), /is not reachable/);
  });

  it('ignores LOCAL_DECIDER_HOST_POLICIES: health is not a policy', async () => {
    const env = { LOCAL_DECIDER_HOST_POLICIES: 'permission,command-risk,routing,turn-outcome' };
    assert.match(systemMessage(await start(answer(null), env)), /is not reachable/);
  });

  it('checks a real unreachable gateway within the 1 s cap', async () => {
    const started = Date.now();
    const res = await run('claude', 'SessionStart', STDIN, {
      LOCAL_DECIDER_URL: 'http://127.0.0.1:1',
      LOCAL_DECIDER_TIMEOUT_MS: '5000',
    });
    assert.match(systemMessage(res.stdout), /gateway at http:\/\/127\.0\.0\.1:1 is not reachable/);
    assert.ok(Date.now() - started < 2000);
  });
});
