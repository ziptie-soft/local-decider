import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStubGateway } from './e2e-stub-gateway.mjs';

const post = (url, path, body) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('stub gateway', () => {
  let stub;
  before(async () => {
    stub = await startStubGateway();
  });
  after(() => stub.close());

  it('answers /health', async () => {
    const res = await fetch(`${stub.url}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  it('records a decide call and answers an unenforced log verdict', async () => {
    const request = { harness: 'codex', scope: 'routing', input: { prompt: 'hi' } };
    const res = await post(stub.url, '/v1/decide/routing', request);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.policy, 'routing');
    assert.equal(body.scope, 'routing');
    assert.equal(body.action, 'log');
    assert.equal(body.enforced, false);
    const call = stub.calls.find((c) => c.policy === 'routing');
    assert.equal(call?.body.harness, 'codex');
  });

  it('answers the model endpoint with 400 and records it apart', async () => {
    const res = await post(stub.url, '/v1/messages', { model: 'x' });
    assert.equal(res.status, 400);
    assert.deepEqual(stub.modelRequests.at(-1), { method: 'POST', path: '/v1/messages' });
    assert.equal(
      stub.calls.some((c) => c.path === '/v1/messages'),
      false,
    );
  });
});
