import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startGateway, type Gateway } from '../src/runtime.ts';
import { controlHeaders, FakeEngine, tempPaths, testConfig } from './helpers.ts';

const paths = tempPaths();
const SENTINEL = 'SENTINEL-review-8842';

const auth = (): Record<string, string> => controlHeaders(paths);

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /v1/review', () => {
  let gw: Gateway;
  let decisionId = '';

  before(async () => {
    gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
      env: {},
    });
    const decided = await fetch(`${gw.url}/v1/decide/permission`, {
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
        call: { id: 'toolu_review_1' },
      }),
    });
    assert.equal(decided.status, 200);
    const record = await json(decided);
    decisionId = String(record['decisionId']);
    assert.equal(record['action'], 'allow');
    // The classifier's last word contradicts the allow: one `classifier-denied` disagreement.
    const outcome = await fetch(`${gw.url}/v1/outcomes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId, outcome: 'deny', source: 'classifier' }),
    });
    assert.equal(outcome.status, 200);
  });
  after(async () => gw.close());

  it('answers 401 without the control token, or with a wrong one', async () => {
    for (const headers of [{}, { 'x-local-decider-control': 'w'.repeat(40) }]) {
      const res = await fetch(`${gw.url}/v1/review`, { headers });
      assert.equal(res.status, 401);
      assert.ok(!JSON.stringify(await res.json()).includes(SENTINEL));
    }
  });

  it('serves the review of the window with the token, hash-only', async () => {
    const res = await fetch(`${gw.url}/v1/review?days=1`, { headers: auth() });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SENTINEL));
    const review = JSON.parse(text) as {
      window: { days: number };
      summary: Record<string, Record<string, number>>;
      disagreements: { decisionId: string; class: string; policy: string }[];
      omitted: number;
    };
    assert.equal(review.window.days, 1);
    assert.equal(review.omitted, 0);
    assert.deepEqual(
      review.disagreements.map((row) => [row.decisionId, row.class, row.policy]),
      [[decisionId, 'classifier-denied', 'permission']],
    );
    assert.equal(review.summary['permission']?.['classifier-denied'], 1);
  });

  it('accepts a limit', async () => {
    const res = await fetch(`${gw.url}/v1/review?limit=1`, { headers: auth() });
    assert.equal(res.status, 200);
    const review = await json(res);
    assert.equal((review['disagreements'] as unknown[]).length, 1);
  });

  it('answers 400 for a bad days or limit', async () => {
    for (const query of ['days=0', 'days=31', 'days=x', 'limit=0', 'limit=1001', 'limit=x']) {
      const res = await fetch(`${gw.url}/v1/review?${query}`, { headers: auth() });
      assert.equal(res.status, 400, query);
    }
  });
});
