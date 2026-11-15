import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { gatewayConfig } from '../src/gateway-config.ts';
import { readEnv } from '../src/mod/gateway.ts';
import type { ModApi, PluginOptions } from '../src/mod/types.ts';
import { run } from '../src/run.ts';

const URL_OPT = 'CLAUDE_PLUGIN_OPTION_GATEWAY_URL';
const TOKEN_OPT = 'CLAUDE_PLUGIN_OPTION_GATEWAY_TOKEN';

describe('gatewayConfig', () => {
  it('defaults to the local gateway with no token', () => {
    assert.deepEqual(gatewayConfig({}), { url: 'http://127.0.0.1:8765', token: undefined });
  });

  it('uses the plugin options when the environment does not set them', () => {
    const env = { [URL_OPT]: 'https://gw.example.com', [TOKEN_OPT]: 'opt-token' };
    assert.deepEqual(gatewayConfig(env), { url: 'https://gw.example.com', token: 'opt-token' });
  });

  it('lets the environment win over the plugin options', () => {
    const env = {
      LOCAL_DECIDER_URL: 'http://127.0.0.1:9000',
      LOCAL_DECIDER_TOKEN: 'env-token',
      [URL_OPT]: 'https://gw.example.com',
      [TOKEN_OPT]: 'opt-token',
    };
    assert.deepEqual(gatewayConfig(env), { url: 'http://127.0.0.1:9000', token: 'env-token' });
  });

  it('pairs the token with the source of the URL', () => {
    const both = { LOCAL_DECIDER_TOKEN: 'env-token', [TOKEN_OPT]: 'opt-token' };
    assert.deepEqual(gatewayConfig({ ...both, LOCAL_DECIDER_URL: 'http://127.0.0.1:9000' }), {
      url: 'http://127.0.0.1:9000',
      token: 'env-token',
    });
    assert.deepEqual(gatewayConfig({ ...both, [URL_OPT]: 'https://gw.example.com' }), {
      url: 'https://gw.example.com',
      token: 'opt-token',
    });
    assert.deepEqual(gatewayConfig(both), { url: 'http://127.0.0.1:8765', token: 'env-token' });
    assert.deepEqual(gatewayConfig({ [TOKEN_OPT]: 'opt-token' }), {
      url: 'http://127.0.0.1:8765',
      token: 'opt-token',
    });
  });

  it('sends no token across sources', () => {
    assert.deepEqual(
      gatewayConfig({ LOCAL_DECIDER_URL: 'http://127.0.0.1:9000', [TOKEN_OPT]: 'opt-token' }),
      { url: 'http://127.0.0.1:9000', token: undefined },
    );
    assert.deepEqual(
      gatewayConfig({ [URL_OPT]: 'https://gw.example.com', LOCAL_DECIDER_TOKEN: 'env-token' }),
      { url: 'https://gw.example.com', token: undefined },
    );
  });

  it('treats empty strings as unset', () => {
    const env = {
      LOCAL_DECIDER_URL: '',
      LOCAL_DECIDER_TOKEN: '',
      [URL_OPT]: 'https://gw.example.com',
      [TOKEN_OPT]: 'opt-token',
    };
    assert.deepEqual(gatewayConfig(env), { url: 'https://gw.example.com', token: 'opt-token' });
    assert.deepEqual(gatewayConfig({ [URL_OPT]: '', [TOKEN_OPT]: '' }), {
      url: 'http://127.0.0.1:8765',
      token: undefined,
    });
  });
});

describe('hook runner with plugin options', () => {
  const base = 'http://127.0.0.1:8999';
  const realFetch = globalThis.fetch;
  let seen: { url: string; headers: Record<string, string> }[] = [];

  // A stand-in gateway: decide errors, /health never answers until the caller aborts.
  before(() => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (url.endsWith('/health')) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  const stdin = JSON.stringify({
    session_id: 's',
    cwd: '/w',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });

  it('reaches the option URL with the option token', async () => {
    seen = [];
    const env = { [URL_OPT]: base, [TOKEN_OPT]: 'opt-token' };
    const res = await run('claude', 'PreToolUse', stdin, env, {
      readTranscript: () => null,
    });
    assert.deepEqual(res, { stdout: '', exitCode: 0 });
    assert.equal(seen[0]?.url, `${base}/v1/decide/command-risk`);
    assert.equal(seen[0]?.headers['authorization'], 'Bearer opt-token');
  });

  it('never sends LOCAL_DECIDER_TOKEN to the option URL', async () => {
    seen = [];
    const env = { LOCAL_DECIDER_TOKEN: 'env-token', [URL_OPT]: base };
    await run('claude', 'PreToolUse', stdin, env, { readTranscript: () => null });
    assert.equal(seen[0]?.url, `${base}/v1/decide/command-risk`);
    assert.equal(seen[0]?.headers['authorization'], undefined);
  });

  it('never sends the option token to LOCAL_DECIDER_URL', async () => {
    seen = [];
    const env = { LOCAL_DECIDER_URL: base, [TOKEN_OPT]: 'opt-token' };
    await run('claude', 'PreToolUse', stdin, env, { readTranscript: () => null });
    assert.equal(seen[0]?.url, `${base}/v1/decide/command-risk`);
    assert.equal(seen[0]?.headers['authorization'], undefined);
  });

  it('never sends the option token to a plain-http remote gateway', async () => {
    seen = [];
    const env = { [URL_OPT]: 'http://10.0.0.5:8765', [TOKEN_OPT]: 'opt-token' };
    await run('claude', 'PreToolUse', stdin, env, { readTranscript: () => null });
    assert.equal(seen[0]?.url, 'http://10.0.0.5:8765/v1/decide/command-risk');
    assert.equal(seen[0]?.headers['authorization'], undefined);
  });

  it('caps the SessionStart health check at 1 s whatever the configured timeout', async () => {
    seen = [];
    const started = Date.now();
    const env = { [URL_OPT]: base, [TOKEN_OPT]: 'opt-token', LOCAL_DECIDER_TIMEOUT_MS: '10000' };
    const res = await run('claude', 'SessionStart', '{}', env);
    const elapsed = Date.now() - started;
    assert.equal(seen[0]?.url, `${base}/health`);
    assert.equal(seen[0]?.headers['authorization'], 'Bearer opt-token');
    assert.ok(elapsed >= 900 && elapsed < 3000, `took ${String(elapsed)} ms`);
    assert.match(res.stdout, /gateway at http:\/\/127\.0\.0\.1:8999 is not reachable/);
    assert.ok(!res.stdout.includes('opt-token'));
  });

  it('uses a shorter configured timeout as is', async () => {
    const started = Date.now();
    await run('claude', 'SessionStart', '{}', { [URL_OPT]: base, LOCAL_DECIDER_TIMEOUT_MS: '50' });
    assert.ok(Date.now() - started < 800);
  });
});

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function modApi(env: Record<string, string>): ModApi {
  return {
    session: { id: unused, cwd: unused, messages: unused, version: unused },
    env: { get: async (name) => env[name] },
    http: { fetch: unused },
    clock: { sleep: async () => undefined },
  };
}

describe('mod readEnv with plugin options', () => {
  const options: PluginOptions = {
    gateway_url: 'https://gw.example.com/',
    gateway_token: 'opt-token',
  };
  const optionToken: PluginOptions = { gateway_token: 'opt-token' };

  it('uses the options when the environment does not set them', async () => {
    const env = await readEnv(modApi({}), options);
    assert.equal(env.baseUrl, 'https://gw.example.com');
    assert.equal(env.token, 'opt-token');
  });

  it('lets the environment win, and ignores empty values', async () => {
    const env = await readEnv(
      modApi({ LOCAL_DECIDER_URL: 'http://127.0.0.1:9000', LOCAL_DECIDER_TOKEN: 'env-token' }),
      options,
    );
    assert.equal(env.baseUrl, 'http://127.0.0.1:9000');
    assert.equal(env.token, 'env-token');
    const empty = await readEnv(modApi({ LOCAL_DECIDER_URL: '', LOCAL_DECIDER_TOKEN: '' }), {
      gateway_url: '',
      gateway_token: '',
    });
    assert.equal(empty.baseUrl, 'http://127.0.0.1:8765');
    assert.equal(empty.token, undefined);
  });

  it('pairs the token with the source of the URL', async () => {
    const envUrl = await readEnv(
      modApi({ LOCAL_DECIDER_URL: 'http://127.0.0.1:9000', LOCAL_DECIDER_TOKEN: 'env-token' }),
      options,
    );
    assert.equal(envUrl.token, 'env-token');
    const crossEnv = await readEnv(modApi({ LOCAL_DECIDER_URL: 'http://127.0.0.1:9000' }), options);
    assert.equal(crossEnv.baseUrl, 'http://127.0.0.1:9000');
    assert.equal(crossEnv.token, undefined);
    const crossOption = await readEnv(modApi({ LOCAL_DECIDER_TOKEN: 'env-token' }), {
      gateway_url: 'https://gw.example.com',
    });
    assert.equal(crossOption.baseUrl, 'https://gw.example.com');
    assert.equal(crossOption.token, undefined);
    const byDefault = await readEnv(modApi({ LOCAL_DECIDER_TOKEN: 'env-token' }), optionToken);
    assert.equal(byDefault.baseUrl, 'http://127.0.0.1:8765');
    assert.equal(byDefault.token, 'env-token');
    const optionDefault = await readEnv(modApi({}), optionToken);
    assert.equal(optionDefault.token, 'opt-token');
  });

  it('never sends the token to a plain-http remote gateway', async () => {
    const env = await readEnv(modApi({}), {
      gateway_url: 'http://10.0.0.5:8765',
      gateway_token: 'opt-token',
    });
    assert.equal(env.baseUrl, 'http://10.0.0.5:8765');
    assert.equal(env.token, undefined);
  });

  it('ignores options that are not strings', async () => {
    const env = await readEnv(modApi({}), { gateway_url: 42, gateway_token: true });
    assert.equal(env.baseUrl, 'http://127.0.0.1:8765');
    assert.equal(env.token, undefined);
  });
});
