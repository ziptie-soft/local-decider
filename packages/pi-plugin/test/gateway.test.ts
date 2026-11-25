import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGateway,
  isEnforcedAllow,
  type DecideReply,
  type DecideRequest,
} from '../extension/gateway.ts';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST: DecideRequest = { harness: 'pi', input: { tool: 'bash' } };

function reply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: ID,
    policy: 'permission',
    mode: 'act',
    action: 'allow',
    enforced: true,
    answers: {},
    ...overrides,
  };
}

interface Seen {
  url: string;
  init: RequestInit;
}

function stub(respond: () => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: typeof url === 'string' ? url : (url as URL).href, init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetch: fakeFetch, seen };
}

function bodyOf(entry: Seen | undefined): unknown {
  const body = entry?.init.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('decide returns a validated reply and posts to the policy route', async () => {
  const { fetch, seen } = stub(() => json(reply()));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765/', fetch });
  const result = await gateway.decide('permission', REQUEST, { timeoutMs: 1500 });
  assert.equal(result?.decisionId, ID);
  assert.equal(seen[0]?.url, 'http://127.0.0.1:8765/v1/decide/permission');
  assert.equal(seen[0]?.init.redirect, 'error');
  assert.equal((bodyOf(seen[0]) as { budgetMs: number }).budgetMs, 1000);
});

test('an absent signal still gets a timeout signal', async () => {
  const { fetch, seen } = stub(() => json(reply()));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch });
  await gateway.decide('permission', REQUEST, { timeoutMs: 1000, signal: undefined });
  assert.ok(seen[0]?.init.signal instanceof AbortSignal);
});

test('the caller signal aborts the call', async () => {
  const { fetch } = stub(() => json(reply()));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch });
  const controller = new AbortController();
  controller.abort();
  const guarded = (async (url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return fetch(url, init);
  }) as typeof fetch;
  const aborted = createGateway({ url: 'http://127.0.0.1:8765', fetch: guarded });
  assert.equal(
    await aborted.decide('permission', REQUEST, { timeoutMs: 1000, signal: controller.signal }),
    null,
  );
  assert.notEqual(await gateway.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
});

test('a slow gateway times out to null', async () => {
  const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    })) as typeof fetch;
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch: slow });
  assert.equal(await gateway.decide('permission', REQUEST, { timeoutMs: 30 }), null);
  assert.equal(await gateway.health({ timeoutMs: 30 }), false);
});

test('a redirect error resolves to null', async () => {
  const redirected = (async () => {
    throw new TypeError('fetch failed: redirect');
  }) as typeof fetch;
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch: redirected });
  assert.equal(await gateway.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
  assert.equal(await gateway.reportOutcome(ID, 'allow', { timeoutMs: 1000 }), false);
});

test('a 500 resolves to null and false', async () => {
  const { fetch } = stub(() => json({ error: 'boom' }, 500));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch });
  assert.equal(await gateway.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
  assert.equal(await gateway.reportOutcome(ID, 'decline', { timeoutMs: 1000 }), false);
  assert.equal(await gateway.health({ timeoutMs: 1000 }), false);
  assert.equal(await gateway.systemOne({}, { timeoutMs: 1000 }), null);
});

test('malformed JSON and malformed replies resolve to null', async () => {
  const bad = stub(() => new Response('{not json', { status: 200 }));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch: bad.fetch });
  assert.equal(await gateway.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
  for (const broken of [
    reply({ decisionId: 'not-a-uuid' }),
    reply({ enforced: 'yes' }),
    reply({ answers: null }),
    reply({ mode: undefined }),
    reply({ action: 7 }),
  ]) {
    const { fetch } = stub(() => json(broken));
    const g = createGateway({ url: 'http://127.0.0.1:8765', fetch });
    assert.equal(await g.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
  }
});

test('a remote http URL withholds the bearer; https and loopback send it', async () => {
  const cases: [string, boolean][] = [
    ['http://example.com:8765', false],
    ['https://example.com', true],
    ['http://127.0.0.1:8765', true],
    ['http://localhost:8765', true],
  ];
  for (const [url, sent] of cases) {
    const { fetch, seen } = stub(() => json(reply()));
    const gateway = createGateway({ url, token: 'secret-token', fetch });
    await gateway.decide('permission', REQUEST, { timeoutMs: 1000 });
    const headers = seen[0]?.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], sent ? 'Bearer secret-token' : undefined, url);
  }
});

test('reportOutcome posts the user source and no report token', async () => {
  const { fetch, seen } = stub(() => json({ ok: true }));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch });
  assert.equal(await gateway.reportOutcome(ID, 'allow', { timeoutMs: 1000 }), true);
  assert.equal(seen[0]?.url, 'http://127.0.0.1:8765/v1/outcomes');
  assert.deepEqual(bodyOf(seen[0]), {
    decisionId: ID,
    outcome: 'allow',
    source: 'user',
  });
  const headers = Object.keys(seen[0]?.init.headers as Record<string, string>);
  assert.ok(!headers.some((h) => h.toLowerCase().includes('report')));
});

test('systemOne posts to /v1/systemone and health reads /health', async () => {
  const one = stub(() => json({ answers: {} }));
  const gateway = createGateway({ url: 'http://127.0.0.1:8765', fetch: one.fetch });
  assert.deepEqual(await gateway.systemOne({ state: 'x' }, { timeoutMs: 1000 }), { answers: {} });
  assert.equal(one.seen[0]?.url, 'http://127.0.0.1:8765/v1/systemone');
  const health = stub(() => json({ status: 'ok' }));
  const g2 = createGateway({ url: 'http://127.0.0.1:8765', fetch: health.fetch });
  assert.equal(await g2.health({ timeoutMs: 1000 }), true);
  assert.equal(health.seen[0]?.url, 'http://127.0.0.1:8765/health');
});

test('an unusable URL never does I/O', async () => {
  const { fetch, seen } = stub(() => json(reply()));
  const gateway = createGateway({ url: 'not a url', fetch });
  assert.equal(await gateway.decide('permission', REQUEST, { timeoutMs: 1000 }), null);
  assert.equal(seen.length, 0);
});

test('isEnforcedAllow needs a valid, enforced, act-mode allow without error', () => {
  const ok = reply() as unknown as DecideReply;
  assert.equal(isEnforcedAllow(ok), true);
  assert.equal(isEnforcedAllow(reply({ enforced: false })), false);
  assert.equal(isEnforcedAllow(reply({ mode: 'shadow' })), false);
  assert.equal(isEnforcedAllow(reply({ action: 'deny' })), false);
  assert.equal(isEnforcedAllow(reply({ error: 'engine busy' })), false);
  assert.equal(isEnforcedAllow(reply({ decisionId: 'x' })), false);
  assert.equal(isEnforcedAllow(null), false);
});
