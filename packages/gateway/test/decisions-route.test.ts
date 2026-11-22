import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startGateway, type Gateway } from '../src/runtime.ts';
import { controlHeaders, FakeEngine, tempPaths, testConfig } from './helpers.ts';

const paths = tempPaths();
const SENTINEL = 'SENTINEL-route-5521';

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const auth = (): Record<string, string> => controlHeaders(paths);

describe('GET /v1/decisions', () => {
  let gw: Gateway;
  let decisionId = '';

  before(async () => {
    // An injected engine means no engineControl: the route must not need one.
    gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
      env: {},
    });
    const res = await fetch(`${gw.url}/v1/decide/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: 'claude-code',
        input: {
          project: '/p',
          tool: 'Bash',
          request: { command: `echo ${SENTINEL}` },
          history: 'user: list files',
        },
        call: { id: 'toolu_route_1' },
      }),
    });
    assert.equal(res.status, 200);
    decisionId = String((await body(res))['decisionId']);
  });
  after(async () => gw.close());

  it('answers 401 without the control token, or with a wrong one', async () => {
    for (const path of [`/v1/decisions/${decisionId}`, '/v1/decisions?call=toolu_route_1']) {
      for (const headers of [{}, { 'x-local-decider-control': 'w'.repeat(40) }]) {
        const res = await fetch(`${gw.url}${path}`, { headers });
        assert.equal(res.status, 401, path);
        assert.ok(!JSON.stringify(await res.json()).includes(SENTINEL));
      }
    }
  });

  it('serves the explanation with the token, hash-only', async () => {
    const res = await fetch(`${gw.url}/v1/decisions/${decisionId}`, { headers: auth() });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SENTINEL));
    const view = JSON.parse(text) as Record<string, unknown>;
    assert.equal(view['decisionId'], decisionId);
    assert.equal(view['tool'], 'Bash');
    assert.equal((view['rule'] as Record<string, unknown>)['changedSinceDecision'], false);
  });

  it('lists the decisions of a call', async () => {
    const res = await fetch(`${gw.url}/v1/decisions?call=toolu_route_1`, { headers: auth() });
    assert.equal(res.status, 200);
    const list = (await res.json()) as Record<string, unknown>[];
    assert.deepEqual(
      list.map((view) => view['decisionId']),
      [decisionId],
    );
  });

  it('projects the agent view with ?view=agent, and refuses other views', async () => {
    const res = await fetch(`${gw.url}/v1/decisions/${decisionId}?view=agent`, {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await body(res)).toSorted(), [
      'action',
      'decisionId',
      'enforced',
      'failedOpen',
      'policy',
      'primary',
      'truncated',
    ]);
    const bad = await fetch(`${gw.url}/v1/decisions/${decisionId}?view=full`, { headers: auth() });
    assert.equal(bad.status, 400);
  });

  it('answers 404 for an unknown or malformed id or call, and 400 without call', async () => {
    for (const path of [
      '/v1/decisions/unknown-id',
      `/v1/decisions/${'a'.repeat(200)}`,
      '/v1/decisions/bad%20id',
      '/v1/decisions?call=nope',
      '/v1/decisions?call=bad%20id',
    ]) {
      assert.equal((await fetch(`${gw.url}${path}`, { headers: auth() })).status, 404, path);
    }
    assert.equal((await fetch(`${gw.url}/v1/decisions`, { headers: auth() })).status, 400);
  });
});
