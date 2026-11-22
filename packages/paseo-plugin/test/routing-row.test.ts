import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawRoutingRow } from '../server/routing-row.ts';
import { createRoutingHandler } from '../server/routing.ts';
import { UsageLinks, type RoutingLink } from '../server/usage.ts';
import { decisionRowSchema, rowSummary, type DecisionRow } from '../shared/row.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

const routed = response({
  decisionId: 'r-1',
  policy: 'routing',
  action: 'route:fast',
  mode: 'act',
  enforced: true,
  route: { preset: 'fast', model: 'claude/haiku' },
  answers: {
    tier: {
      type: 'choice',
      answer: 'fast',
      probabilities: { fast: 0.8, deep: 0.2 },
      confidence: 0.8,
    },
  },
});

const link = (over: Partial<RoutingLink> = {}): RoutingLink => ({
  decision: Promise.resolve(routed),
  applied: true,
  note: '→ claude/haiku',
  ...over,
});

const withRouting = (
  mode: 'off' | 'shadow' | 'act',
  rows: DeciderSettings['rows'] = { show: 'all', details: true, feedback: true },
): DeciderSettings =>
  settings({
    modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': mode },
    rows,
  });

async function draw(
  s: DeciderSettings,
  l: RoutingLink,
): Promise<{ rows: DecisionRow[]; ids: string[] }> {
  const paseo = fakePaseo([]);
  await drawRoutingRow(deps(s, null), paseo, 'a1', l);
  return {
    rows: paseo.agent.appended.map((item) => decisionRowSchema.parse(item.data)),
    ids: paseo.agent.appended.map((item) => item.id),
  };
}

describe('routing handler → link', () => {
  const noItems = { entries: [] };
  const userPaseo = {
    config: { get: async () => ({ config: { agentProfiles: [] } }) },
    agents: {
      list: async () => noItems,
      ref: () => ({ timeline: { refetch: async () => noItems } }),
    },
  };
  const act = settings({
    modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'act' },
    presets: {
      fast: { model: 'claude/haiku', modeId: '' },
      standard: { model: '', modeId: '' },
      deep: { model: '', modeId: '' },
    },
  });

  it('records the applied target as the link note', async () => {
    const links = new UsageLinks();
    const handler = createRoutingHandler(
      deps(
        act,
        fakeGateway(() => routed),
      ),
      undefined,
      links,
    );
    const out = await handler(
      { request: { config: { provider: 'claude', cwd: '/p', model: 'opus', title: 'T' } } },
      { signal: new AbortController().signal, paseo: userPaseo },
    );
    assert.equal(out?.config.model, 'haiku');
    const created = links.created({ id: 'a1', cwd: '/p', title: 'T' });
    assert.ok(created);
    assert.equal(created.applied, true);
    assert.match(created.note ?? '', /^→ claude\/haiku/);
    assert.equal((await created.decision)?.decisionId, 'r-1');
  });
});

describe('drawRoutingRow', () => {
  it('draws an applied act route with the target note', async () => {
    const { rows, ids } = await draw(withRouting('act'), link());
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.source, 'routing');
    assert.equal(row.applied, true);
    assert.equal(row.note, '→ claude/haiku');
    assert.deepEqual(ids, ['local-decider-routing-r-1']);
    assert.match(rowSummary(row), /^routing · → claude\/haiku · .*act$/);
  });

  it('notes why a delegated creator kept its model', async () => {
    const { rows } = await draw(
      withRouting('act'),
      link({ applied: false, note: "kept the creator's model" }),
    );
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.applied, false);
    assert.match(rowSummary(row), /kept the creator's model/);
  });

  it('draws shadow routing only under rows.show: all', async () => {
    const shadow = link({ applied: false, note: null });
    assert.equal((await draw(withRouting('shadow'), shadow)).rows.length, 1);
    const notable = withRouting('shadow', { show: 'notable', details: true, feedback: true });
    assert.equal((await draw(notable, shadow)).rows.length, 0);
  });

  it('draws nothing without a decision, when routing is off or rows are off', async () => {
    assert.equal(
      (await draw(withRouting('act'), link({ decision: Promise.resolve(null) }))).rows.length,
      0,
    );
    assert.equal((await draw(withRouting('off'), link())).rows.length, 0);
    const off = withRouting('act', { show: 'off', details: true, feedback: true });
    assert.equal((await draw(off, link())).rows.length, 0);
  });
});
