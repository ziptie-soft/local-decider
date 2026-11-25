import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Background } from '../server/background.ts';
import { createPermissionHandlers, type PermissionOptions } from '../server/permission.ts';
import { decisionRowSchema, rowSummary, type DecisionRow } from '../shared/row.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { ctx, deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

const agent: PluginHookAgent = {
  id: 'a1',
  workspaceId: 'w1',
  parentAgentId: null,
  provider: 'claude',
  cwd: '/p',
  title: null,
  background: false,
  metadata: {},
};

const request = (id: string): AgentPermissionRequest => ({
  id,
  provider: 'claude',
  name: 'Bash',
  kind: 'tool',
  input: { command: 'ls' },
});

const verdict = response({
  policy: 'permission',
  action: 'ask',
  mode: 'act',
  enforced: true,
  answers: {
    verdict: {
      type: 'choice',
      answer: 'deny',
      probabilities: { allow: 0.1, deny: 0.9 },
      confidence: 0.9,
    },
  },
});

const act = (extra: Partial<DeciderSettings> = {}): DeciderSettings =>
  settings({
    modes: { 'turn-outcome': 'act', 'permission': 'act', 'routing': 'shadow' },
    ...extra,
  });

const rowsOf = (paseo: ReturnType<typeof fakePaseo>): DecisionRow[] =>
  paseo.agent.appended.map((item) => decisionRowSchema.parse(item.data));

function setup(options: {
  settings?: DeciderSettings;
  decide?: () => ReturnType<Parameters<typeof fakeGateway>[0]>;
  bg?: Background;
  permission?: PermissionOptions;
}): {
  bg: Background;
  handlers: ReturnType<typeof createPermissionHandlers>;
  paseo: ReturnType<typeof fakePaseo>;
  ask: (id: string) => Promise<void>;
} {
  const bg = options.bg ?? new Background();
  const gw = fakeGateway(options.decide ?? (() => verdict));
  const handlers = createPermissionHandlers(deps(options.settings ?? act(), gw), bg, {
    pendingAfterMs: 5,
    ...options.permission,
  });
  const paseo = fakePaseo([]);
  const ask = async (id: string): Promise<void> =>
    handlers.before({ agent, request: request(id) }, ctx(paseo));
  return { bg, handlers, paseo, ask };
}

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('pending permission row', () => {
  it('draws "deciding…" for a slow decision, then the decided row with the same id', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { bg, paseo, ask } = setup({ decide: async () => gate.then(() => verdict) });
    await ask('r1');
    await wait(40);
    assert.equal(paseo.agent.appended.length, 1);
    assert.equal(rowSummary(rowsOf(paseo)[0] as DecisionRow), 'permission · deciding… · act');
    resolve();
    await bg.idle();
    const rows = rowsOf(paseo);
    assert.equal(rows.length, 2);
    assert.equal(paseo.agent.appended[0]?.id, paseo.agent.appended[1]?.id);
    assert.equal(rows[1]?.state, 'decided');
  });

  it('draws no pending row for a fast decision', async () => {
    const { bg, paseo, ask } = setup({ permission: { pendingAfterMs: 5000 } });
    await ask('r1');
    await bg.idle();
    assert.deepEqual(
      rowsOf(paseo).map((r) => r.state),
      ['decided'],
    );
  });

  it('turns a pending row into "not decided" when there is no decision', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { bg, paseo, ask } = setup({ decide: async () => gate.then(() => null) });
    await ask('r1');
    await wait(40);
    resolve();
    await bg.idle();
    const rows = rowsOf(paseo);
    assert.deepEqual(
      rows.map((r) => [r.state, r.reason]),
      [
        ['pending', null],
        ['skipped', 'no-answer'],
      ],
    );
    assert.equal(
      rowSummary(rows[1] as DecisionRow),
      'permission · not decided · answer it yourself',
    );
  });

  it('draws no pending row once the user has answered', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { bg, handlers, paseo, ask } = setup({ decide: async () => gate.then(() => verdict) });
    await ask('r1');
    await handlers.after({
      agent,
      requestId: 'r1',
      resolution: { behavior: 'deny', message: 'no' },
    });
    await wait(40);
    assert.equal(paseo.agent.appended.length, 0);
    resolve();
    await bg.idle();
  });

  it('finalizes the id even when rows.show would hide the decided row', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { bg, paseo, ask } = setup({
      settings: act({ rows: { show: 'notable', details: true, feedback: true } }),
      decide: async () => gate.then(() => ({ ...verdict, answers: {} })),
    });
    await ask('r1');
    await wait(40);
    resolve();
    await bg.idle();
    assert.deepEqual(
      rowsOf(paseo).map((r) => r.state),
      ['pending', 'decided'],
    );
  });

  it('draws nothing in shadow', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { bg, paseo, ask } = setup({
      settings: settings({ rows: { show: 'notable', details: true, feedback: true } }),
      decide: async () => gate.then(() => null),
    });
    await ask('r1');
    await wait(40);
    resolve();
    await bg.idle();
    assert.equal(paseo.agent.appended.length, 0);
  });
});

describe('skipped permission rows', () => {
  it('draws one "busy" row per agent a minute when Background is full', async () => {
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const bg = new Background(1);
    const { paseo, ask } = setup({ bg, decide: async () => gate.then(() => verdict) });
    await ask('r1');
    await ask('r2');
    await ask('r3');
    const skipped = rowsOf(paseo).filter((r) => r.state === 'skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.reason, 'busy');
    const [first] = skipped;
    assert.ok(first);
    assert.equal(rowSummary(first), 'permission · skipped: busy · answer it yourself');
    resolve();
    await bg.idle();
  });

  it('draws a "rate-limit" row past the per-agent limit', async () => {
    const { bg, paseo, ask } = setup({ permission: { now: () => 0, pendingAfterMs: 5000 } });
    for (let i = 0; i < 21; i += 1) {
      await ask(`r${String(i)}`);
      await bg.idle();
    }
    const skipped = rowsOf(paseo).filter((r) => r.state === 'skipped');
    assert.deepEqual(
      skipped.map((r) => r.reason),
      ['rate-limit'],
    );
  });

  it('draws a "deadline" row when the deadline is spent before decide', async () => {
    const clock = { t: 0 };
    const { bg, paseo, ask } = setup({ permission: { now: () => clock.t } });
    paseo.agent.timeline.refetch = async () => {
      clock.t += 9500;
      return { entries: [] };
    };
    await ask('r1');
    await bg.idle();
    assert.deepEqual(
      rowsOf(paseo).map((r) => [r.state, r.reason]),
      [['skipped', 'deadline']],
    );
  });

  it('draws no skipped row in shadow, or when rows are off', async () => {
    for (const s of [settings(), act({ rows: { show: 'off', details: true, feedback: true } })]) {
      const { promise: gate, resolve } = Promise.withResolvers<void>();
      const bg = new Background(1);
      const { paseo, ask } = setup({
        bg,
        settings: s,
        decide: async () => gate.then(() => verdict),
      });
      await ask('r1');
      await ask('r2');
      assert.equal(paseo.agent.appended.length, 0);
      resolve();
      await bg.idle();
    }
  });

  it('never throws when the append fails', async () => {
    const bg = new Background(1);
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const { paseo, ask } = setup({ bg, decide: async () => gate.then(() => verdict) });
    paseo.agent.timeline.append = async () => Promise.reject(new Error('boom'));
    await ask('r1');
    await ask('r2');
    resolve();
    await bg.idle();
  });
});
