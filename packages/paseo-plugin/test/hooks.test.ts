import type {
  PluginHookAgent,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
} from '@getpaseo/plugin/server';
import type { AgentPermissionRequest, AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Background } from '../server/background.ts';
import type { HookDeps } from '../server/deps.ts';
import { LabelRegistry } from '../server/labels.ts';
import { createOpenHandler, hostEnv } from '../server/open.ts';
import { allowResponse, createPermissionHandlers } from '../server/permission.ts';
import { createRoutingHandler, type CreateRequest } from '../server/routing.ts';
import { createStatusHandler, manualDecide } from '../server/rpc.ts';
import { createTurnHandler, pluginEnforces } from '../server/turn.ts';
import { AGENT_TOOL_NAMES, POLICY_WRITER_LABEL, POLICY_WRITER_TITLE } from '../shared/constants.ts';
import { statusSchema } from '../shared/status.ts';
import { ctx, deps, fakeGateway, fakePaseo, response, settings, withConfigDir } from './fakes.ts';

type Paseo = ReturnType<typeof fakePaseo>;

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

const turn: { item: AgentTimelineItem; turnId?: string }[] = [
  { item: { type: 'user_message', text: 'Add tests' }, turnId: 't1' },
  { item: { type: 'assistant_message', text: 'Should I use vitest or node:test?' }, turnId: 't1' },
];

const toolItem = (name: string): AgentTimelineItem => ({
  type: 'tool_call',
  callId: name,
  name,
  status: 'completed',
  error: null,
  detail: { type: 'unknown', input: null, output: null },
});

const completed = { kind: 'completed' } as const;

/** A boolean field of an appended row's data. */
function flag(item: { data: unknown } | undefined, key: string): unknown {
  assert.ok(item !== undefined, 'a row was appended');
  return (item.data as Record<string, unknown>)[key];
}

describe('pluginEnforces', () => {
  it('needs gateway enforcement, plugin act and no engine error', () => {
    assert.equal(pluginEnforces(response({ enforced: true }), 'act'), true);
    assert.equal(pluginEnforces(response({ enforced: true }), 'shadow'), false);
    assert.equal(pluginEnforces(response({ enforced: false }), 'act'), false);
    assert.equal(pluginEnforces(response({ enforced: true, error: 'x' }), 'act'), false);
  });
});

describe('agent.turn.after', () => {
  const bg = new Background();
  const turnHandler = (
    d: HookDeps,
  ): ((paseo: Paseo, outcome?: PluginTurnOutcome) => Promise<void>) => {
    const handler = createTurnHandler(d, { background: bg });
    return async (paseo, outcome = completed) => {
      await handler({ agent, turnId: 't1', outcome }, ctx(paseo));
      await bg.idle();
    };
  };

  it('returns before the decision and appends one row per turn when it lands', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const gw = fakeGateway(async () => {
      await gate;
      return response({ action: 'notify', mode: 'act', enforced: true });
    });
    const s = settings({
      modes: { 'turn-outcome': 'act', 'permission': 'shadow', 'routing': 'shadow' },
    });
    const paseo = fakePaseo(turn);
    const handler = createTurnHandler(deps(s, gw), { background: bg });
    await handler({ agent, turnId: 't1', outcome: completed }, ctx(paseo));
    assert.equal(paseo.agent.appended.length, 0, 'hook returned before the decision');
    release();
    await bg.idle();
    await handler({ agent, turnId: 't1', outcome: completed }, ctx(paseo));
    await bg.idle();

    assert.equal(gw.calls.length, 1, 'deduped per turn');
    assert.equal(gw.calls[0]?.policy, 'turn-outcome');
    assert.equal(gw.calls[0]?.sessionId, 'a1');
    assert.deepEqual(Object.keys(gw.calls[0]?.input ?? {}), ['task', 'history', 'lastMessage']);
    assert.equal(paseo.agent.appended.length, 1);
    const row = paseo.agent.appended[0];
    assert.equal(row?.id, 'local-decider-turn-t1');
    assert.equal(row?.kind, 'decision');
    assert.equal(flag(row, 'attention'), true);
  });

  it('records but never flags attention in shadow mode', async () => {
    const gw = fakeGateway(() => response({ action: 'notify', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn);
    await turnHandler(deps(settings(), gw))(paseo);
    assert.equal(flag(paseo.agent.appended[0], 'attention'), false);
  });

  it('does nothing when off, canceled, or the gateway is down', async () => {
    const off = settings({
      modes: { 'turn-outcome': 'off', 'permission': 'shadow', 'routing': 'shadow' },
    });
    const gw = fakeGateway(() => response());
    const paseo = fakePaseo(turn);
    await turnHandler(deps(off, gw))(paseo);
    await turnHandler(deps(settings(), gw))(paseo, { kind: 'canceled', reason: 'user' });
    await turnHandler(
      deps(
        settings(),
        fakeGateway(() => null),
      ),
    )(paseo);
    assert.equal(gw.calls.length, 0);
    assert.equal(paseo.agent.appended.length, 0);
  });

  it('skips a failed turn like a canceled one, and still decides a completed one', async () => {
    const gw = fakeGateway(() => response({ action: 'notify', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn);
    await turnHandler(deps(settings(), gw))(paseo, { kind: 'failed', error: { message: 'boom' } });
    assert.equal(gw.calls.length, 0);
    assert.equal(paseo.agent.appended.length, 0);
    await turnHandler(deps(settings(), gw))(paseo, completed);
    assert.equal(gw.calls.length, 1);
    assert.equal(paseo.agent.appended.length, 1);
  });

  it('swallows timeline failures', async () => {
    const d = deps(
      settings(),
      fakeGateway(() => response()),
    );
    const paseo = fakePaseo(turn);
    paseo.agent.timeline.refetch = async () => {
      throw new Error('agent gone');
    };
    await turnHandler(d)(paseo);
    assert.match(d.logs[0] ?? '', /agent gone/);
  });
});

const toolRequest: AgentPermissionRequest = {
  id: 'r1',
  provider: 'claude',
  name: 'Bash',
  kind: 'tool',
  input: { command: 'ls' },
};

const actMode = settings({
  modes: { 'turn-outcome': 'shadow', 'permission': 'act', 'routing': 'shadow' },
});

describe('agent.permission.before', () => {
  const bg = new Background();
  const permissionHandlers = (
    d: HookDeps,
  ): ReturnType<typeof createPermissionHandlers> & {
    request: (paseo: Paseo, request?: AgentPermissionRequest) => Promise<void>;
  } => {
    const handlers = createPermissionHandlers(d, bg);
    return {
      ...handlers,
      request: async (paseo, request = toolRequest) => {
        await handlers.before({ agent, request }, ctx(paseo));
        await bg.idle();
      },
    };
  };

  const labelled = (
    d: HookDeps,
    labels: LabelRegistry,
  ): ReturnType<typeof createPermissionHandlers> & { request: (paseo: Paseo) => Promise<void> } => {
    const handlers = createPermissionHandlers(d, bg, { labels, now: () => 1_000 });
    return {
      ...handlers,
      request: async (paseo: Paseo) => {
        await handlers.before({ agent, request: toolRequest }, ctx(paseo));
        await bg.idle();
      },
    };
  };

  it('caps a 3 MiB request input before it reaches the gateway', async () => {
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const huge: AgentPermissionRequest = {
      ...toolRequest,
      input: { command: `START${'x'.repeat(3 * 1024 * 1024)}END` },
    };
    await permissionHandlers(deps(settings(), gw)).request(fakePaseo(turn), huge);
    const sent = gw.calls[0]?.input;
    assert.ok(JSON.stringify(sent).length < 256 * 1024);
    const request = String((sent as Record<string, unknown>)['request']);
    assert.ok(request.startsWith('{"command":"START'));
    assert.match(request, /chars truncated/);
    assert.equal('subject' in (sent as object), false, 'an over-cap subject is dropped');
  });

  it('auto-allows only an enforced allow with the plugin in act', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(actMode, gw));
    await handlers.request(paseo);
    assert.deepEqual(paseo.agent.responses, [{ requestId: 'r1', response: { behavior: 'allow' } }]);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), true);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.equal(gw.outcomes.length, 0, 'own auto-allow is not ground truth');
  });

  it('does not auto-allow calls the deterministic checks flag, but still records them', async () => {
    const flagged: AgentPermissionRequest[] = [
      { ...toolRequest, name: 'Write', input: { file_path: '/etc/hosts' } },
      { ...toolRequest, input: { command: ['su', 'do ls'].join('') } },
      { ...toolRequest, input: { command: ['rm -r', 'f /'].join('') } },
      { ...toolRequest, name: 'shell', input: { cmd: ['su', 'do ls'].join('') } },
    ];
    for (const request of flagged) {
      const gw = fakeGateway(() =>
        response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
      );
      const paseo = fakePaseo(turn);
      await permissionHandlers(deps(actMode, gw)).request(paseo, request);
      assert.deepEqual(paseo.agent.responses, [], `${request.name} stays pending`);
      assert.equal(paseo.agent.appended.length, 1, 'still recorded');
    }
  });

  it('still auto-allows an edit inside the working directory', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn);
    const request = { ...toolRequest, name: 'Edit', input: { file_path: '/p/src/a.ts' } };
    await permissionHandlers(deps(actMode, gw)).request(paseo, request);
    assert.deepEqual(paseo.agent.responses, [{ requestId: 'r1', response: { behavior: 'allow' } }]);
  });

  it('allows its own agent tools without a decision, row or limiter tick', async () => {
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const on = settings({ agentTools: true });
    for (const tool of AGENT_TOOL_NAMES) {
      const paseo = fakePaseo(turn);
      const request = { ...toolRequest, name: `mcp__paseo__${tool}`, input: {} };
      await permissionHandlers(deps(on, gw)).request(paseo, request);
      assert.deepEqual(paseo.agent.responses, [
        { requestId: 'r1', response: { behavior: 'allow' } },
      ]);
      assert.equal(paseo.agent.appended.length, 0, 'no row');
    }
    assert.equal(gw.calls.length, 0, 'no decide');
  });

  it('leaves its own agent tools to the user when agent tools are off', async () => {
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const paseo = fakePaseo(turn);
    const request = { ...toolRequest, name: 'mcp__paseo__local_decider_decide', input: {} };
    await permissionHandlers(deps(settings(), gw)).request(paseo, request);
    assert.deepEqual(paseo.agent.responses, []);
    assert.equal(gw.calls.length, 0);
    assert.equal(paseo.agent.appended.length, 0);
  });

  it('never allows other paseo tools, and skips Codex paseo elicitations', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const on = settings({
      agentTools: true,
      modes: { 'turn-outcome': 'shadow', 'permission': 'act', 'routing': 'shadow' },
    });
    for (const name of ['mcp__paseo__create_agent', 'mcp__paseo__local_decider_other']) {
      const paseo = fakePaseo(turn);
      await permissionHandlers(deps(on, gw)).request(paseo, { ...toolRequest, name, input: {} });
      assert.deepEqual(paseo.agent.responses, [], name);
    }
    const before = gw.calls.length;
    const paseo = fakePaseo(turn);
    const elicitation = {
      ...toolRequest,
      provider: 'codex',
      name: 'CodexMcpElicitation',
      metadata: { serverName: 'paseo' },
      input: {},
    };
    await permissionHandlers(deps(on, gw)).request(paseo, elicitation);
    assert.deepEqual(paseo.agent.responses, []);
    assert.equal(paseo.agent.appended.length, 0);
    assert.equal(gw.calls.length, before, 'no decide for the elicitation');
  });

  it('allows only the exact tool names: no look-alike, case or suffix', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const on = settings({
      agentTools: true,
      modes: { 'turn-outcome': 'shadow', 'permission': 'act', 'routing': 'shadow' },
    });
    const names = [
      'MCP__PASEO__LOCAL_DECIDER_DECIDE',
      'mcp__paseo__Local_Decider_Decide',
      'mcp__paseo__local_decider_decide ',
      ' mcp__paseo__local_decider_decide',
      'mcp__paseo__local_decider_decide_all',
      'mcp__paseo__local_decider_decide\u0000',
      'mcp__paseo__local_decider_decıde',
      'mcp__paseo__local․decider_decide',
      'mcp__paseo_local_decider_decide',
      'mcp__other__local_decider_decide',
      'mcp__paseo__mcp__paseo__local_decider_decide',
      'local_decider_decide',
    ];
    for (const name of names) {
      const paseo = fakePaseo(turn);
      await permissionHandlers(deps(on, gw)).request(paseo, { ...toolRequest, name, input: {} });
      assert.deepEqual(paseo.agent.responses, [], JSON.stringify(name));
    }
  });

  it('never denies and leaves the request pending otherwise', async () => {
    for (const [s, res] of [
      [actMode, response({ action: 'deny', mode: 'act', enforced: true })],
      [actMode, response({ action: 'allow', mode: 'shadow', enforced: false })],
      [settings(), response({ action: 'allow', mode: 'act', enforced: true })],
    ] as const) {
      const paseo = fakePaseo(turn);
      await permissionHandlers(
        deps(
          s,
          fakeGateway(() => res),
        ),
      ).request(paseo);
      assert.deepEqual(paseo.agent.responses, []);
      assert.equal(paseo.agent.appended.length, 1, 'still recorded');
    }
  });

  it('keeps task context after it falls outside the 100 item window', async () => {
    let items: { item: AgentTimelineItem }[] = [
      { item: { type: 'user_message', text: 'Build parser' } },
    ];
    const limits: number[] = [];
    const paseo = fakePaseo(items);
    paseo.agent.timeline.refetch = async (options) => {
      limits.push(options.limit);
      return { entries: items.slice(-options.limit) };
    };
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const handlers = permissionHandlers(deps(settings(), gw));

    await handlers.request(paseo);
    items = [
      ...Array.from({ length: 120 }, (_, index) => ({ item: toolItem(`Tool${index}`) })),
      { item: { type: 'user_message', text: 'Narrow the change' } },
    ];
    await handlers.request(paseo, { ...toolRequest, id: 'r2' });

    assert.deepEqual(limits, [100, 100]);
    assert.equal(
      gw.calls[1]?.input['task'],
      'First request: Build parser\nLatest request: Narrow the change',
    );
    assert.equal(String(gw.calls[1]?.input['history']).split('\n').length, 20);
  });

  it('swallows the already-resolved race', async () => {
    const gw = fakeGateway(() => response({ action: 'allow', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn, async () => {
      throw new Error('Permission request r1 is not pending');
    });
    const d = deps(actMode, gw);
    await permissionHandlers(d).request(paseo);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
    assert.equal(d.logs.length, 1, 'a rejection with no answer is logged once');
    assert.match(d.logs[0] ?? '', /^permission allow not applied: Permission request r1 is not/);
  });

  it('does not log a rejection after the user answered, and reports the user', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
    const paseo = fakePaseo(turn, async () => {
      await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      throw new Error('Permission request r1 is not pending');
    });
    const d = deps(actMode, gw);
    handlers = createPermissionHandlers(d, bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(d.logs, []);
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
  });

  it('keeps the outcome ours and logs a rejection once per interval', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn, async () => {
      throw new Error('boom\nsecond line');
    });
    const d = deps(actMode, gw);
    let t = 1_000;
    const handlers = createPermissionHandlers(d, bg, { now: () => t });
    for (const id of ['r1', 'r2']) {
      await handlers.before({ agent, request: { ...toolRequest, id } }, ctx(paseo));
      await bg.idle();
    }
    assert.deepEqual(d.logs, ['permission allow not applied: boom']);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.deepEqual(gw.outcomes, [], 'autoAllowed stays set');
    t += 60_000;
    await handlers.before({ agent, request: { ...toolRequest, id: 'r3' } }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(d.logs, [
      'permission allow not applied: boom',
      'permission allow not applied: boom (1 similar suppressed)',
    ]);
  });

  it('logs a send that never settles as a timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn, () => new Promise<void>(() => {}));
    const d = deps(actMode, gw);
    const handlers = createPermissionHandlers(d, bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    while (paseo.agent.responses.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    t.mock.timers.tick(10_000);
    await bg.idle();
    assert.deepEqual(d.logs, ['permission allow timed out']);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
  });

  it('skips questions and plan approvals, and reports user answers as outcomes', async () => {
    const gw = fakeGateway(() => response({ action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(settings(), gw));
    await handlers.request(paseo, { ...toolRequest, id: 'q', kind: 'question' });
    assert.equal(gw.calls.length, 0);
    await handlers.request(paseo);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
  });

  it('reports one user outcome and redraws the row with it', async () => {
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(settings(), gw));
    await handlers.request(paseo);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'allow', source: 'user' }]);
    assert.equal(paseo.agent.appended.length, 2);
    assert.equal(paseo.agent.appended[1]?.id, paseo.agent.appended[0]?.id, 'same row id');
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), null);
    assert.equal(flag(paseo.agent.appended[1], 'feedback'), 'allow');
  });

  it('reports parent answers as supervised outcomes', async () => {
    const child = { ...agent, id: 'child', parentAgentId: 'parent' };
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = createPermissionHandlers(deps(settings(), gw), bg);
    await handlers.before({ agent: child, request: toolRequest }, ctx(paseo));
    await bg.idle();
    await handlers.after({ agent: child, requestId: 'r1', resolution: { behavior: 'deny' } });

    assert.deepEqual(gw.outcomes, [
      { decisionId: 'd-1', outcome: 'decline', source: 'supervised' },
    ]);
  });

  it('keeps a user answer that arrives before the decision lands', async () => {
    const gate = Promise.withResolvers<void>();
    const gw = fakeGateway(async () => {
      await gate.promise;
      return response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true });
    });
    const paseo = fakePaseo(turn);
    const handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    // Let the detached task reach `decide`.
    await new Promise((resolve) => setImmediate(resolve));
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
    gate.resolve();
    await bg.idle();
    assert.deepEqual(paseo.agent.responses, [], 'no allow after the user answered');
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
    assert.equal(paseo.agent.appended.length, 1);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), 'decline');
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
  });

  it('does not report its own auto-allow when after fires mid-response', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
    const paseo = fakePaseo(turn, async () => {
      await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    });
    handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(gw.outcomes, []);
    assert.equal(paseo.agent.appended.length, 1);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), true);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), null);
  });

  it('reports the user when their answer beat our allow', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
    const paseo = fakePaseo(turn, async () => {
      await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      throw new Error('Permission request r1 is not pending');
    });
    handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), 'decline');
  });

  describe('outcome labels', () => {
    const rowId = 'local-decider-permission-r1';

    it('maps an interrupting deny to interrupted and a plain deny to decline', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const paseo = fakePaseo(turn);
      const handlers = labelled(deps(settings(), gw), new LabelRegistry());
      await handlers.request(paseo);
      await handlers.after({
        agent,
        requestId: 'r1',
        resolution: { behavior: 'deny', interrupt: true },
      });
      assert.equal(gw.outcomes[0]?.outcome, 'interrupted');
      assert.equal(flag(paseo.agent.appended[1], 'feedback'), 'interrupted');
      await handlers.request(paseo);
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(gw.outcomes[1]?.outcome, 'decline');
    });

    it('stamps answeredAt and registers a declined row', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const paseo = fakePaseo(turn);
      const labels = new LabelRegistry();
      const handlers = labelled(deps(settings(), gw), labels);
      await handlers.request(paseo);
      assert.equal(labels.get(agent.id, rowId), undefined, 'unanswered rows are not labelable');
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(flag(paseo.agent.appended[1], 'answeredAt'), 1_000);
      const entry = labels.get(agent.id, rowId);
      assert.equal(entry?.kind, 'declined');
      assert.equal(entry?.decisionId, 'd-1');
      assert.equal(entry?.answeredAt, 1_000);
    });

    it('registers a keyed auto-allow and not an unkeyed one', async () => {
      const keyed = fakeGateway(() =>
        response({
          policy: 'permission',
          action: 'allow',
          mode: 'act',
          enforced: true,
          precedentKey: 'k',
        }),
      );
      const labels = new LabelRegistry();
      const paseo = fakePaseo(turn);
      await labelled(deps(actMode, keyed), labels).request(paseo);
      assert.equal(flag(paseo.agent.appended[0], 'answeredAt'), 1_000);
      assert.equal(flag(paseo.agent.appended[0], 'vetoable'), true);
      assert.equal(labels.get(agent.id, rowId)?.kind, 'auto-allowed');

      const unkeyed = fakeGateway(() =>
        response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
      );
      const other = new LabelRegistry();
      await labelled(deps(actMode, unkeyed), other).request(fakePaseo(turn));
      assert.equal(other.get(agent.id, rowId), undefined);
    });

    it('does not register hidden rows or the user allow', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const hidden = new LabelRegistry();
      const hiddenHandlers = labelled(
        deps(settings({ rows: { show: 'off', details: true, feedback: true } }), gw),
        hidden,
      );
      await hiddenHandlers.request(fakePaseo(turn));
      await hiddenHandlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(hidden.get(agent.id, rowId), undefined);

      const allowed = new LabelRegistry();
      const handlers = labelled(deps(settings(), gw), allowed);
      await handlers.request(fakePaseo(turn));
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
      assert.equal(allowed.get(agent.id, rowId), undefined);
    });
  });

  it('picks a one-shot allow, never an always or session one, else abstains', () => {
    const no = { id: 'no', label: 'No', behavior: 'deny' } as const;
    const pick = (...actions: NonNullable<AgentPermissionRequest['actions']>): unknown =>
      allowResponse({ ...toolRequest, actions });
    assert.deepEqual(allowResponse(toolRequest), { behavior: 'allow' });
    assert.deepEqual(
      pick(
        no,
        { id: 'always', label: 'Always allow', behavior: 'allow', variant: 'primary' },
        { id: 'session', label: 'Allow for this session', behavior: 'allow' },
        { id: 'once', label: 'Allow once', behavior: 'allow' },
      ),
      { behavior: 'allow', selectedActionId: 'once' },
    );
    assert.deepEqual(pick({ id: 'allow', label: 'Allow', behavior: 'allow' }), {
      behavior: 'allow',
      selectedActionId: 'allow',
    });
    assert.equal(
      pick(
        no,
        { id: 'always', label: 'Always allow', behavior: 'allow', variant: 'primary' },
        { id: 'session', label: 'Allow for session', behavior: 'allow' },
      ),
      null,
    );
  });

  it('does not auto-allow when only persistent allow actions exist', async () => {
    const gw = fakeGateway(() => response({ action: 'allow', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn);
    await permissionHandlers(deps(actMode, gw)).request(paseo, {
      ...toolRequest,
      actions: [{ id: 'always', label: 'Always allow', behavior: 'allow', variant: 'primary' }],
    });
    assert.deepEqual(paseo.agent.responses, []);
  });

  it('auto-allows only shell and edit tools, leaving the rest to the user', async () => {
    const gw = fakeGateway(() => response({ action: 'allow', mode: 'act', enforced: true }));
    const allowed = [
      toolRequest,
      { ...toolRequest, name: 'Edit', input: { file_path: 'a.ts' } },
      { ...toolRequest, name: 'unknown-shell', detail: { type: 'shell', command: 'ls' } },
    ] satisfies AgentPermissionRequest[];
    const left = [
      { ...toolRequest, name: 'mcp__github__create_issue' },
      { ...toolRequest, name: 'SomethingNew' },
      { ...toolRequest, name: 'Read' },
      { ...toolRequest, name: 'mcp__x__run', detail: { type: 'shell', command: 'ls' } },
    ] satisfies AgentPermissionRequest[];
    for (const [request, count] of [
      ...allowed.map((r) => [r, 1] as const),
      ...left.map((r) => [r, 0] as const),
    ]) {
      const paseo = fakePaseo(turn);
      await permissionHandlers(deps(actMode, gw)).request(paseo, request);
      assert.equal(paseo.agent.responses.length, count, request.name);
      assert.equal(paseo.agent.appended.length, 1, 'still recorded');
    }
  });

  it('records an answer given before settings load, as a user outcome', async () => {
    const gate = Promise.withResolvers<void>();
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const d = deps(actMode, gw);
    const slow: HookDeps = {
      ...d,
      settings: async () => {
        await gate.promise;
        return d.settings();
      },
    };
    const paseo = fakePaseo(turn);
    const handlers = createPermissionHandlers(slow, bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    gate.resolve();
    await bg.idle();
    assert.deepEqual(paseo.agent.responses, [], 'the plugin does not decide after the user');
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'allow', source: 'user' }]);
  });

  it('keeps an allow whose send failed as the plugin own, never a user allow', async () => {
    for (const failure of [
      async (): Promise<void> => {
        throw new Error('socket closed');
      },
    ]) {
      const gw = fakeGateway(() =>
        response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
      );
      let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
      const paseo = fakePaseo(turn, async () => {
        // The daemon applied the allow and emitted `after` before the call failed.
        await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
        await failure();
      });
      handlers = createPermissionHandlers(deps(actMode, gw), bg);
      await handlers.before({ agent, request: toolRequest }, ctx(paseo));
      await bg.idle();
      assert.deepEqual(gw.outcomes, [], 'not reported as source user');
      assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
      assert.equal(flag(paseo.agent.appended[0], 'feedback'), null);
    }
  });

  it('keeps a failed send with no answer seen as the plugin own', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn, async () => {
      throw new Error('socket closed');
    });
    const handlers = permissionHandlers(deps(actMode, gw));
    await handlers.request(paseo);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.deepEqual(gw.outcomes, []);
  });
});

const createRequest = (title: string | null): { request: CreateRequest } => ({
  request: { config: { provider: 'claude', cwd: '/p', model: 'opus', title } },
});

const routingAct = settings({
  modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'act' },
  presets: {
    fast: { model: 'claude/haiku', modeId: '' },
    standard: { model: '', modeId: '' },
    deep: { model: 'codex/gpt-5.5', modeId: '' },
  },
});

const autoProfileRoute = (): ReturnType<typeof response> =>
  response({
    policy: 'routing',
    action: 'route:fast',
    mode: 'act',
    enforced: true,
    route: { preset: 'fast', profile: 'implementer' },
  });
const noItems = { entries: [] };
const profileConfig = {
  get: async () => ({
    config: {
      agentProfiles: [{ id: 'implementer', provider: 'claude', model: 'haiku', modeId: 'auto' }],
    },
  }),
};
const userPaseo = {
  config: profileConfig,
  agents: {
    list: async () => noItems,
    ref: () => ({ timeline: { refetch: async () => noItems } }),
  },
};
const paseoWithProfile = userPaseo;
const withMode = (modeId: string | undefined, provider = 'claude'): { request: CreateRequest } => ({
  request: {
    config: {
      provider,
      cwd: '/p',
      model: 'opus',
      title: 'Rename',
      ...(modeId === undefined ? {} : { modeId }),
    },
  },
});

const outer = new AbortController().signal;

const createCall = (name: string, title: string): AgentTimelineItem =>
  ({
    type: 'tool_call',
    callId: 'c1',
    name,
    status: 'running',
    detail: { type: 'unknown', input: { title }, output: null },
    error: null,
  }) as unknown as AgentTimelineItem;

const parentWith = (items: AgentTimelineItem[], order: string[] = []): typeof userPaseo => ({
  ...userPaseo,
  agents: {
    list: async () => {
      order.push('list');
      return { entries: [{ agent: { id: 'p1' } }] } as typeof noItems;
    },
    ref: () => ({
      timeline: {
        refetch: async () => ({ entries: items.map((item) => ({ item })) }) as typeof noItems,
      },
    }),
  },
});

const running = (count: number): typeof userPaseo => ({
  ...userPaseo,
  agents: {
    list: async () =>
      ({
        entries: Array.from({ length: count }, (_, i) => ({
          agent: { id: `a${String(i)}` },
        })),
      }) as typeof noItems,
    ref: userPaseo.agents.ref,
  },
});

const route = async (
  paseo: unknown,
  title = 'Rename',
): Promise<{ out: CreateRequest | undefined; d: ReturnType<typeof deps> }> => {
  const d = deps(routingAct, fakeGateway(autoProfileRoute));
  const out = await createRoutingHandler(d)(createRequest(title), {
    signal: outer,
    paseo: paseo as typeof userPaseo,
  });
  return { out, d };
};

const writer = (cwd: string): { request: CreateRequest } => ({
  request: { config: { provider: 'claude', cwd, model: 'opus', title: POLICY_WRITER_TITLE } },
});

const routeWith = async (
  mode: string,
  model: string,
  config: CreateRequest['config'],
): Promise<{ out: CreateRequest | undefined; d: ReturnType<typeof deps> }> => {
  const gw = fakeGateway(() =>
    response({
      policy: 'routing',
      action: 'route:fast',
      mode: 'act',
      enforced: true,
      route: { preset: 'fast', model, mode },
    }),
  );
  const d = deps(routingAct, gw);
  const out = await createRoutingHandler(d)(
    { request: { config } },
    { signal: outer, paseo: userPaseo },
  );
  return { out, d };
};

describe('agent.create.before', () => {
  const signal = new AbortController().signal;

  it('applies an enforced, mapped preset', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'routing', action: 'route:fast', mode: 'act', enforced: true }),
    );
    const out = await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename foo'), {
      signal,
      paseo: userPaseo,
    });
    assert.equal(out?.config.model, 'haiku');
    assert.deepEqual(gw.calls[0]?.input, { project: '/p', prompt: 'Rename foo' });
  });

  it('applies the route the gateway resolved from config.yaml over plugin settings', async () => {
    const gw = fakeGateway(() =>
      response({
        policy: 'routing',
        action: 'route:fast',
        mode: 'act',
        enforced: true,
        route: { preset: 'fast', model: 'codex/gpt-mini', mode: 'auto' },
      }),
    );
    const out = await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename'), {
      signal,
      paseo: userPaseo,
    });
    assert.equal(out?.config.provider, 'codex');
    assert.equal(out?.config.model, 'gpt-mini');
    assert.equal(out?.config.modeId, 'auto');
  });

  describe('caller mode', () => {
    it('keeps the mode the caller pinned', async () => {
      const gw = fakeGateway(autoProfileRoute);
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode('default'), {
        signal,
        paseo: paseoWithProfile,
      });
      assert.equal(out?.config.model, 'haiku');
      assert.equal(out?.config.modeId, 'default');
    });

    it('applies the profile mode when the caller left it unset', async () => {
      const gw = fakeGateway(autoProfileRoute);
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode(undefined), {
        signal,
        paseo: paseoWithProfile,
      });
      assert.equal(out?.config.modeId, 'auto');
    });

    it('does not route a pinned agent to another provider', async () => {
      const gw = fakeGateway(() =>
        response({
          policy: 'routing',
          action: 'route:fast',
          mode: 'act',
          enforced: true,
          route: { preset: 'fast', model: 'claude/haiku', mode: 'auto' },
        }),
      );
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode('default', 'codex'), {
        signal,
        paseo: userPaseo,
      });
      assert.equal(out, undefined);
    });
  });

  it('applies a preset of a user-written routing variant', async () => {
    const gw = fakeGateway(() =>
      response({
        policy: 'routing',
        variant: 'routing-mine',
        action: 'route:cheap',
        mode: 'act',
        enforced: true,
      }),
    );
    const mine = { ...routingAct, presets: { cheap: { model: 'codex/gpt-mini', modeId: '' } } };
    const out = await createRoutingHandler(deps(mine, gw))(createRequest('Docs'), {
      signal,
      paseo: userPaseo,
    });
    assert.equal(out?.config.provider, 'codex');
    assert.equal(out?.config.model, 'gpt-mini');
  });

  it('changes nothing when unmapped, not enforced, without a prompt, or on failure', async () => {
    const cases = [
      [routingAct, response({ action: 'route:standard', mode: 'act', enforced: true })],
      [routingAct, response({ action: 'route:fast', mode: 'shadow', enforced: false })],
      [settings(), response({ action: 'route:fast', mode: 'act', enforced: true })],
      [routingAct, null],
    ] as const;
    for (const [s, res] of cases) {
      assert.equal(
        await createRoutingHandler(
          deps(
            s,
            fakeGateway(() => res),
          ),
        )(createRequest('Task'), { signal, paseo: userPaseo }),
        undefined,
      );
    }
    const gw = fakeGateway(() => response());
    assert.equal(
      await createRoutingHandler(deps(routingAct, gw))(createRequest(null), {
        signal,
        paseo: userPaseo,
      }),
      undefined,
    );
    assert.equal(gw.calls.length, 0);
  });

  it('never waits in shadow mode but still sends the decision for the log', async () => {
    const slow = fakeGateway(async () => new Promise(() => {}));
    const started = Date.now();
    const out = await createRoutingHandler(deps(settings(), slow))(createRequest('Task'), {
      signal,
      paseo: userPaseo,
    });
    assert.equal(out, undefined);
    assert.ok(Date.now() - started < 50);
    assert.equal(slow.calls.length, 1);
  });

  it('gives up within its budget and never throws', async () => {
    const slow = fakeGateway(async () => new Promise(() => {}));
    const started = Date.now();
    const out = await createRoutingHandler(deps(routingAct, slow), 100)(createRequest('Task'), {
      signal,
      paseo: userPaseo,
    });
    assert.equal(out, undefined);
    assert.ok(Date.now() - started < 1000);

    const broken = deps(routingAct, null);
    broken.settings = async () => {
      throw new Error('settings exploded');
    };
    assert.equal(
      await createRoutingHandler(broken)(createRequest('Task'), { signal, paseo: userPaseo }),
      undefined,
    );
    assert.match(broken.logs[0] ?? '', /settings exploded/);
  });

  it('skips the gateway entirely while it is known to be down', async () => {
    const gw = fakeGateway(() => response({ action: 'route:fast', mode: 'act', enforced: true }));
    const d = { ...deps(routingAct, gw), gatewayKnownDown: () => true };
    assert.equal(
      await createRoutingHandler(d)(createRequest('Task'), { signal, paseo: userPaseo }),
      undefined,
    );
    assert.equal(gw.calls.length, 0);
  });

  describe('remaining budget', () => {
    it('skips decide when less than a second is left after planning', async () => {
      const clock = { t: 0 };
      const gw = fakeGateway(budgetRes);
      const d = clockDeps(gw, clock, 1200);
      const h = createRoutingHandler(d, 2000, undefined, () => clock.t);
      assert.equal(await h(createRequest('Task'), { signal, paseo: userPaseo }), undefined);
      assert.equal(gw.calls.length, 0);
      assert.ok(d.logs.some((l) => l.includes('budget spent before decide')));
      assert.equal(d.downs, 0);
    });

    it('passes the remaining budget to the gateway', async () => {
      const clock = { t: 0 };
      const gw = fakeGateway(budgetRes);
      const d = clockDeps(gw, clock, 500);
      const h = createRoutingHandler(d, 2000, undefined, () => clock.t);
      assert.equal(
        (await h(createRequest('Task'), { signal, paseo: userPaseo }))?.config.model,
        'haiku',
      );
      assert.equal(gw.calls[0]?.timeoutMs, 1500);
    });

    it('marks the gateway down when it takes the whole budget', async () => {
      const gw = fakeGateway(async () => new Promise(() => {}));
      const d = clockDeps(gw, { t: 0 }, 0);
      const h = createRoutingHandler(d, 1100);
      assert.equal(await h(createRequest('Task'), { signal, paseo: userPaseo }), undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(d.downs, 1);
    });

    it('does not mark it down on a fast failure or a caller abort', async () => {
      const fast = clockDeps(
        fakeGateway(() => null),
        { t: 0 },
        0,
      );
      await createRoutingHandler(fast)(createRequest('Task'), { signal, paseo: userPaseo });
      assert.equal(fast.downs, 0);

      const controller = new AbortController();
      const hung = clockDeps(
        fakeGateway(async () => new Promise(() => {})),
        { t: 0 },
        0,
      );
      const pending = createRoutingHandler(hung)(createRequest('Task'), {
        signal: controller.signal,
      });
      controller.abort();
      await pending;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(hung.downs, 0);
    });
  });

  describe('delegation', () => {
    it('keeps the creator model of a delegated agent (Claude and Codex tool names)', async () => {
      for (const name of ['mcp__paseo__create_agent', 'paseo.create_agent']) {
        const { out, d } = await route(parentWith([createCall(name, 'Rename')]));
        assert.equal(out, undefined, name);
        assert.ok(d.logs.some((l) => l.includes("kept the creator's model (delegated)")));
      }
    });

    it('still asks the gateway for a delegated agent, to log the decision', async () => {
      const gw = fakeGateway(autoProfileRoute);
      await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename'), {
        signal,
        paseo: parentWith([createCall('mcp__paseo__create_agent', 'Rename')]),
      });
      assert.equal(gw.calls.length, 1);
    });

    it('routes when no running agent is creating one with that title', async () => {
      const other = parentWith([createCall('mcp__paseo__create_agent', 'Other')]);
      assert.equal((await route(other)).out?.config.model, 'haiku');
      assert.equal((await route(userPaseo)).out?.config.model, 'haiku');
    });

    it('skips the route when the lookup fails, hangs, or is unavailable', async () => {
      const failing = {
        ...userPaseo,
        agents: {
          list: async () => {
            throw new Error('boom');
          },
          ref: userPaseo.agents.ref,
        },
      };
      assert.equal((await route(failing)).out, undefined);
      assert.equal((await route({ config: profileConfig })).out, undefined);
      const hung = {
        agents: { list: async () => new Promise(() => {}), ref: userPaseo.agents.ref },
      };
      const gw = fakeGateway(autoProfileRoute);
      const controller = new AbortController();
      const pending = createRoutingHandler(deps(routingAct, gw), 300)(createRequest('Rename'), {
        signal: controller.signal,
        paseo: hung as unknown as typeof userPaseo,
      });
      assert.equal(await pending, undefined);
    });

    it('skips the route when more agents run than it can inspect and none matches', async () => {
      const full = await route(running(9));
      assert.equal(full.out, undefined);
      assert.ok(full.d.logs.some((l) => l.includes("kept the creator's model (unknown)")));
      assert.equal((await route(running(8))).out?.config.model, 'haiku');
    });

    it('starts the lookup concurrently with decide', async () => {
      const order: string[] = [];
      const gw = fakeGateway(() => {
        order.push('decide');
        return autoProfileRoute();
      });
      await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename'), {
        signal,
        paseo: parentWith([], order),
      });
      assert.deepEqual(order.toSorted(), ['decide', 'list']);
    });
  });

  describe('policy writer', () => {
    it('skips the plugin policy writer in the config dir, but not the same title elsewhere', async () => {
      await withConfigDir('/cfg/local-decider', async () => {
        const gw = fakeGateway(autoProfileRoute);
        const h = createRoutingHandler(deps(routingAct, gw));
        assert.equal(
          await h(writer('/cfg/local-decider'), { signal, paseo: userPaseo }),
          undefined,
        );
        assert.equal(gw.calls.length, 0);
        const out = await h(writer('/elsewhere'), { signal, paseo: userPaseo });
        assert.equal(out?.config.model, 'haiku');
        assert.equal(gw.calls.length, 1);
      });
    });
  });

  describe('mode guard', () => {
    it('applies a mode no more permissive than the agent has', async () => {
      const { out } = await routeWith('plan', 'claude/haiku', {
        provider: 'claude',
        cwd: '/p',
        model: 'opus',
        title: 'T',
      });
      assert.equal(out?.config.modeId, 'plan');
    });

    it('drops a more permissive mode on the same provider and keeps the model', async () => {
      const { out, d } = await routeWith('bypassPermissions', 'claude/haiku', {
        provider: 'claude',
        cwd: '/p',
        model: 'opus',
        title: 'T',
      });
      assert.equal(out?.config.model, 'haiku');
      assert.equal(out?.config.modeId, undefined);
      assert.ok(d.logs.some((l) => l.includes('dropped preset mode bypassPermissions')));
    });

    it('skips a route to another provider whose mode would raise permissions', async () => {
      const { out, d } = await routeWith('full-access', 'codex/gpt-5.5', {
        provider: 'claude',
        cwd: '/p',
        model: 'opus',
        title: 'T',
      });
      assert.equal(out, undefined);
      assert.ok(d.logs.some((l) => l.includes('would raise permissions')));
    });
  });
});

const budgetRes = (): ReturnType<typeof response> =>
  response({ policy: 'routing', action: 'route:fast', mode: 'act', enforced: true });
const clockDeps = (
  gw: ReturnType<typeof fakeGateway>,
  clock: { t: number },
  spend: number,
): HookDeps & { downs: number; logs: string[] } => {
  const d = deps(routingAct, gw);
  const settingsFn = d.settings.bind(d);
  const out = Object.assign(d, {
    downs: 0,
    settings: async () => {
      clock.t += spend;
      return settingsFn();
    },
    markGatewayDown: () => {
      out.downs += 1;
    },
  });
  return out;
};

const open = (purpose: 'interactive' | 'history'): { request: PluginSessionOpenRequest } => ({
  request: {
    agentId: 'a1',
    workspaceId: 'w1',
    provider: 'claude',
    cwd: '/p',
    reason: 'resume',
    purpose,
    title: null,
    labels: {},
    tools: [],
    env: {},
    mcpServers: {},
    background: false,
    metadata: {},
  },
});

describe('agent.open.before', () => {
  it('attaches the agent tools only when enabled', async () => {
    const gw = fakeGateway(() => null);
    const on = createOpenHandler(deps(settings({ agentTools: true }), gw));
    const out = await on(open('interactive'));
    assert.deepEqual(
      out?.tools.map((tool) => tool.name),
      [...AGENT_TOOL_NAMES],
    );
    assert.equal(await on(open('history')), undefined);
    const off = await createOpenHandler(deps(settings(), gw))(open('interactive'));
    assert.deepEqual(off?.tools, []);
    assert.deepEqual(off?.mcpServers, {});
  });

  it('keeps the policy-writer agent free of tools but still sets the env', async () => {
    const gw = fakeGateway(() => null);
    const request = open('interactive').request;
    const policyWriter = {
      request: { ...request, labels: { [POLICY_WRITER_LABEL]: 'policy-writer' } },
    };
    const out = await createOpenHandler(deps(settings({ agentTools: true }), gw))(policyWriter);
    assert.deepEqual(out?.tools, []);
    assert.equal(out?.env['LOCAL_DECIDER_HOST_POLICIES'], 'turn-outcome,permission,routing');
  });

  it('does no gateway I/O when an agent opens', async () => {
    const gw = fakeGateway(() => null);
    await createOpenHandler(deps(settings({ agentTools: true }), gw))(open('interactive'));
    assert.equal(gw.agentCalls.length, 0);
    assert.equal(gw.calls.length, 0);
  });

  it('names tools to fit the SDK pattern and carries no URL or token', async () => {
    const gw = fakeGateway(() => null);
    const out = await createOpenHandler(deps(settings({ agentTools: true }), gw))(
      open('interactive'),
    );
    for (const tool of out?.tools ?? []) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
      assert.ok(tool.name.startsWith('local_decider_'));
    }
    const json = JSON.stringify(out, (_key, value: unknown) =>
      typeof value === 'function' ? undefined : value,
    );
    assert.doesNotMatch(json, /127\.0\.0\.1|8765|token|bearer/i);
    assert.deepEqual(out?.mcpServers, {});
  });

  it('tells the harness hooks which policies Paseo runs', async () => {
    const gw = fakeGateway(() => null);
    const out = await createOpenHandler(deps(settings(), gw))(open('interactive'));
    assert.equal(out?.env['LOCAL_DECIDER_HOST_POLICIES'], 'turn-outcome,permission,routing');
  });

  it('keeps policies already listed in the env', () => {
    const env = hostEnv({ PATH: '/bin', LOCAL_DECIDER_HOST_POLICIES: 'command-risk, routing' });
    assert.equal(env['PATH'], '/bin');
    assert.equal(
      env['LOCAL_DECIDER_HOST_POLICIES'],
      'command-risk,routing,turn-outcome,permission',
    );
  });
});

describe('rpc handlers', () => {
  it('tracks the down streak for client backoff', async () => {
    const up = fakeGateway(() => null);
    let healthy = false;
    up.health = async () => (healthy ? { status: 'ok', model: 'm', p50Ms: 5 } : null);
    const status = createStatusHandler(deps(settings(), up), () => new Date(0));
    assert.equal((await status()).downStreak, 1);
    assert.equal((await status()).downStreak, 2);
    healthy = true;
    const ok = await status();
    assert.deepEqual(ok, {
      up: true,
      status: 'ok',
      engine: null,
      engineTag: null,
      engineState: null,
      detail: null,
      model: 'm',
      p50Ms: 5,
      benchmark: null,
      gatewayUrl: 'http://127.0.0.1:8765',
      downStreak: 0,
      checkedAt: '1970-01-01T00:00:00.000Z',
      launch: null,
    });
  });

  it('includes the auto-launch summary when health is down', async () => {
    const gw = fakeGateway(() => null);
    gw.health = async () => null;
    let attempts = 0;
    const status = createStatusHandler(
      deps(settings(), gw),
      () => new Date(0),
      () => {},
      async () => {
        attempts++;
        return { ok: false, status: 'not-installed', message: 'install the gateway manually' };
      },
    );
    const result = await status();
    assert.equal(attempts, 1);
    assert.deepEqual(result.launch, {
      ok: false,
      status: 'not-installed',
      message: 'install the gateway manually',
    });
    assert.deepEqual(statusSchema.parse(result).launch, result.launch);
  });

  it('reads the benchmark progress from health, leniently', async () => {
    const gw = fakeGateway(() => null);
    let benchmark: unknown = { completed: 3, total: 6 };
    gw.health = async () => ({ status: 'ok', benchmark });
    const status = createStatusHandler(deps(settings(), gw), () => new Date(0));
    assert.deepEqual((await status()).benchmark, { completed: 3, total: 6 });
    benchmark = { completed: 'x' };
    assert.equal((await status()).benchmark, null);
    benchmark = null;
    assert.equal((await status()).benchmark, null);
  });

  it('passes policyEngines through from health, and leaves it out for an older gateway', async () => {
    const gw = fakeGateway(() => null);
    let policyEngines: unknown = [
      {
        policy: 'command-risk',
        engine: 'llama',
        model: 'm2',
        label: 'M2',
        state: 'ready',
        status: 'active',
        fallback: 'default',
        queueDepth: 2,
        extra: 'ignored',
      },
      { engine: 'no policy id' },
      { policy: 'p', state: 'sideways', queueDepth: -1 },
    ];
    gw.health = async () => ({ status: 'ok', policyEngines }) as never;
    const status = createStatusHandler(deps(settings(), gw), () => new Date(0));
    assert.deepEqual((await status()).policyEngines, [
      {
        policy: 'command-risk',
        engine: 'llama',
        model: 'm2',
        label: 'M2',
        state: 'ready',
        status: 'active',
        fallback: 'default',
        queueDepth: 2,
      },
      {
        policy: 'p',
        state: undefined,
        queueDepth: undefined,
      },
    ]);
    const withEngines = await status();
    assert.deepEqual(statusSchema.parse(withEngines).policyEngines, withEngines.policyEngines);
    policyEngines = [];
    assert.deepEqual((await status()).policyEngines, []);
    policyEngines = 'x';
    assert.equal((await status()).policyEngines, undefined);
    gw.health = async () => ({ status: 'ok' });
    const older = await status();
    assert.equal(older.policyEngines, undefined);
    assert.ok(!('policyEngines' in older));
    assert.equal(statusSchema.parse(older).policyEngines, undefined);
  });

  it('manual decide appends an unenforced row, and throws when the gateway is down', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'routing', action: 'route:fast', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo([]);
    const row = await manualDecide(deps(settings(), gw), paseo, {
      policy: 'routing',
      text: 'x',
      agentId: 'a1',
    });
    assert.equal(row.enforced, false);
    assert.deepEqual(gw.calls[0]?.input, { prompt: 'x' });
    assert.equal(paseo.agent.appended[0]?.id, 'local-decider-manual-d-1');
    await assert.rejects(
      manualDecide(
        deps(
          settings(),
          fakeGateway(() => null),
        ),
        paseo,
        { policy: 'routing', text: 'x', agentId: null },
      ),
      /no decision/,
    );
  });
});

describe('Background', () => {
  it('refuses work at capacity and after stop, and never rejects', async () => {
    const bg = new Background(1);
    const errors: unknown[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    assert.equal(
      bg.run(
        async () => gate,
        (e) => errors.push(e),
      ),
      true,
    );
    assert.equal(
      bg.run(
        async () => {},
        (e) => errors.push(e),
      ),
      false,
    );
    release();
    await bg.idle();
    assert.equal(
      bg.run(
        async () => Promise.reject(new Error('x')),
        (e) => errors.push(e),
      ),
      true,
    );
    await bg.idle();
    assert.equal(errors.length, 1);
    bg.stop();
    assert.equal(
      bg.run(
        async () => {},
        () => {},
      ),
      false,
    );
  });
});
