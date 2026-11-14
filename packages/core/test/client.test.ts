import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { GatewayClient, loopbackUrl, trimTrailingSlashes } from '../src/index.ts';

async function decideBody(body: unknown, scope?: 'claude-auto'): Promise<unknown> {
  const client = new GatewayClient({ fetch: async () => Response.json(body) });
  return client.decide('permission', {
    harness: 'codex',
    input: {},
    ...(scope === undefined ? {} : { scope }),
  });
}

describe('decision response validation', () => {
  const valid = {
    decisionId: 'd-1',
    policy: 'permission',
    mode: 'act',
    action: 'allow',
    enforced: true,
    answers: {
      q: { type: 'choice', answer: 'allow', probabilities: { allow: 1, deny: 0 }, confidence: 1 },
    },
    rule: 0,
    engine: 'test',
    model: 'test',
    latencyMs: 1,
    cached: false,
  };
  it('accepts valid decisions and non-enforced errors', async () => {
    assert.deepEqual(await decideBody(valid), valid);
    const failed = {
      ...valid,
      enforced: false,
      action: 'abstain',
      answers: {},
      error: 'engine unavailable',
    };
    assert.deepEqual(await decideBody(failed), failed);
    const scoped = { ...valid, scope: 'claude-auto' };
    assert.deepEqual(await decideBody(scoped, 'claude-auto'), scoped);
    const routed = { ...valid, action: 'route:fast', route: { preset: 'fast', model: 'model' } };
    assert.deepEqual(await decideBody(routed), routed);
  });

  it('validates answer confidence and probability distributions before enforcement', async () => {
    for (const probabilities of [
      { allow: 0.96, deny: 0 },
      { allow: 0.52, deny: 0.52 },
    ]) {
      const body = { ...valid, answers: { q: { ...valid.answers.q, probabilities } } };
      assert.deepEqual(await decideBody(body), body);
    }
    const malformedAnswers = [
      { confidence: -0.01 },
      { confidence: 1.01 },
      { probabilities: {} },
      { probabilities: { allow: 1 } },
      { probabilities: { '': 1 } },
      { probabilities: { ' ': 1 } },
      { probabilities: { allow: -0.01, deny: 1 } },
      { probabilities: { allow: 1.01 } },
      { probabilities: { allow: 0.94 } },
      { probabilities: { allow: 0.53, deny: 0.53 } },
      { answer: 'deny' },
      { engineConfidence: -1 },
      { engineConfidence: 2 },
      { score: 1 },
    ];
    const bad = [
      { ...valid, answers: {} },
      ...malformedAnswers.map((overrides) => ({
        ...valid,
        answers: { q: { ...valid.answers.q, ...overrides } },
      })),
    ];
    for (const body of bad) {
      assert.equal(await decideBody(body), null, JSON.stringify(body));
    }
  });

  it('checks noul and score answer semantics', async () => {
    const noul = {
      type: 'noul',
      answer: 'false',
      probabilities: { false: 0.5, true: 0.5 },
      confidence: 0,
    };
    const score = {
      type: 'score',
      answer: 'high',
      probabilities: { low: 0.2, high: 0.8 },
      confidence: 0.6,
      score: 0.8,
    };
    for (const answer of [noul, score]) {
      const body = { ...valid, answers: { q: answer } };
      assert.deepEqual(await decideBody(body), body);
    }
    for (const answer of [
      { ...noul, answer: 'true' },
      { ...noul, probabilities: { false: 0.5, other: 0.5 } },
      { ...score, score: undefined },
      { ...score, score: 2 },
      { ...score, answer: 'low' },
    ]) {
      assert.equal(await decideBody({ ...valid, answers: { q: answer } }), null);
    }
  });

  it('rejects non-finite numbers returned by the response parser', async () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const overrides of [{ confidence: invalid }, { probabilities: { allow: invalid } }]) {
        const body = { ...valid, answers: { q: { ...valid.answers.q, ...overrides } } };
        const client = new GatewayClient({
          fetch: async () => ({ status: 200, json: async () => body }) as unknown as Response,
        });
        assert.equal(await client.decide('permission', { harness: 'codex', input: {} }), null);
      }
    }
  });

  it('rejects malformed and inconsistent responses before enforcement', async () => {
    const bad = [
      null,
      [],
      { ...valid, enforced: 'false' },
      { ...valid, decisionId: '' },
      { ...valid, decisionId: 'bad id' },
      { ...valid, policy: 'routing' },
      { ...valid, action: 'allow now' },
      { ...valid, mode: 'shadow' },
      { ...valid, error: 'engine unavailable' },
      { ...valid, answers: [] },
      { ...valid, answers: { q: { type: 'choice', answer: 'a', confidence: '1' } } },
      { ...valid, rule: -2 },
      { ...valid, route: { preset: 42 } },
      { ...valid, action: 'route:fast', route: { preset: 'other' } },
      { ...valid, precedent: { allows: -1, denies: 0 } },
      { ...valid, scope: 'other' },
      { ...valid, scope: 'claude-auto' },
    ];
    for (const body of bad) {
      assert.equal(await decideBody(body), null, JSON.stringify(body));
    }
    assert.equal(await decideBody(valid, 'claude-auto'), null, 'scope must be echoed');
  });
});

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    assert.equal(trimTrailingSlashes('http://h:1/v1///'), 'http://h:1/v1');
    assert.equal(trimTrailingSlashes('http://h:1'), 'http://h:1');
    assert.equal(trimTrailingSlashes('///'), '');
    assert.equal(trimTrailingSlashes(''), '');
  });

  it('stays linear on a long run of slashes', () => {
    const value = `${'/'.repeat(200_000)}x`;
    assert.equal(trimTrailingSlashes(value), value);
  });
});

describe('GatewayClient', () => {
  let server: Server;
  let redirectServer: Server;
  let url = '';
  let redirectUrl = '';
  let lastAuth: string | undefined;
  let lastControl: string | string[] | undefined;
  let redirectMode = false;
  let redirected = 0;

  before(async () => {
    redirectServer = createServer((_req, res) => {
      redirected += 1;
      res.end('{}');
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    redirectUrl = `http://127.0.0.1:${String((redirectServer.address() as AddressInfo).port)}`;
    server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      lastControl = req.headers['x-local-decider-control'];
      if (redirectMode && (req.url === '/health' || req.url?.startsWith('/v1/decide/'))) {
        res.statusCode = 302;
        res.setHeader('location', `${redirectUrl}/hit`);
        res.end();
        return;
      }
      if (req.url === '/slow') {
        return;
      }
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/v1/outcomes') {
        res.end('{}');
        return;
      }
      if (req.url === '/v1/engines') {
        res.setHeader('content-type', 'application/json');
        res.end('{"engines":[],"models":[]}');
        return;
      }
      if (req.url === '/v1/engine') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end('{"error":"unknown model"}');
        return;
      }
      res.statusCode = 500;
      res.end('{"error":"boom"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    redirectServer.closeAllConnections();
    redirectServer.close();
  });

  it('returns parsed JSON and sends the bearer token', async () => {
    const client = new GatewayClient({ baseUrl: `${url}/`, token: 't0k', controlToken: 'control' });
    assert.deepEqual(await client.health(), { status: 'ok' });
    assert.equal(lastAuth, 'Bearer t0k');
    assert.equal(lastControl, 'control');
    assert.equal(await client.reportOutcome('d1', 'allow'), true);
  });

  it('fails open (null) on HTTP errors', async () => {
    const client = new GatewayClient({ baseUrl: url });
    assert.equal(await client.decide('permission', { harness: 'cli', input: {} }), null);
    assert.equal(lastAuth, undefined);
  });

  it('lists engines and preserves selection error status and body', async () => {
    const client = new GatewayClient({ baseUrl: url });
    assert.deepEqual(await client.engines(), { engines: [], models: [] });
    assert.deepEqual(await client.selectEngine({ engine: 'openai-compatible', model: 'missing' }), {
      status: 400,
      body: { error: 'unknown model' },
    });
  });

  it('fails open on timeouts and refused connections', async () => {
    const slow = new GatewayClient({ baseUrl: `${url}/slow#`, timeoutMs: 50 });
    assert.equal(await slow.health(), null);
    const down = new GatewayClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(await down.health(), null);
  });

  it('sends the control token only to loopback', async () => {
    let headers = new Headers();
    const client = new GatewayClient({
      baseUrl: 'https://example.test',
      controlToken: 'control',
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ status: 'ok' });
      },
    });
    assert.deepEqual(await client.health(), { status: 'ok' });
    assert.equal(headers.get('x-local-decider-control'), null);
  });

  it('refuses redirects without contacting a second loopback server', async () => {
    const client = new GatewayClient({ baseUrl: url });
    redirected = 0;
    redirectMode = true;
    try {
      assert.equal(await client.health(), null);
      assert.equal(await client.decide('permission', { harness: 'cli', input: {} }), null);
      assert.equal(redirected, 0);
    } finally {
      redirectMode = false;
    }
  });
});

describe('tokenAllowed', () => {
  it('allows https and loopback, refuses plain http to other hosts', async () => {
    const { tokenAllowed } = await import('../src/client.ts');
    assert.equal(tokenAllowed('https://gw.example:8765'), true);
    assert.equal(tokenAllowed('http://127.0.0.1:8765'), true);
    assert.equal(tokenAllowed('http://localhost:8765'), true);
    assert.equal(tokenAllowed('http://[::1]:8765'), true);
    assert.equal(tokenAllowed('http://127.8.9.10:8765'), true);
    assert.equal(tokenAllowed('http://127.evil.example:8765'), false);
    assert.equal(tokenAllowed('http://192.168.1.10:8765'), false);
    assert.equal(tokenAllowed('not a url'), false);
  });
});

describe('loopbackUrl', () => {
  it('accepts loopback hosts but rejects lookalike names and invalid URLs', () => {
    for (const url of [
      'http://127.0.0.1:1',
      'http://127.9.9.9',
      'http://localhost',
      'http://[::1]:8765',
    ]) {
      assert.equal(loopbackUrl(url), true, url);
    }
    for (const url of [
      'http://127.0.0.1.evil.test',
      'http://localhost.evil.test',
      'https://example.com',
      'not a url',
    ]) {
      assert.equal(loopbackUrl(url), false, url);
    }
  });
});
