import type { AgentToolContext, AgentToolDefinition } from '@getpaseo/plugin/server';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentTools } from '../server/agent-tools.ts';
import { AGENT_TOOL_NAMES } from '../shared/constants.ts';
import { agentView, deps, fakeGateway, settings, type FakeGateway } from './fakes.ts';

const NAME_RULE = /^[a-z][a-z0-9_]*$/;
const UUID = '11111111-1111-4111-8111-111111111111';

function context(id = 'agent-1', signal = new AbortController().signal): AgentToolContext {
  return {
    agent: {
      id,
      workspaceId: null,
      parentAgentId: null,
      provider: 'claude',
      cwd: '/work/project',
      title: null,
    },
    paseo: {} as never,
    signal,
  };
}

function setup(gateway: FakeGateway | null = fakeGateway(() => null)): {
  tools: Map<string, AgentToolDefinition>;
  gateway: FakeGateway | null;
  logs: string[];
  clock: { now: number };
} {
  const clock = { now: 1_000_000 };
  const d = deps(settings(), gateway);
  const tools = new Map(
    agentTools(d, { now: () => clock.now }).map((tool) => [tool.name, tool] as const),
  );
  return { tools, gateway, logs: d.logs, clock };
}

async function call(
  tools: Map<string, AgentToolDefinition>,
  name: string,
  input: unknown,
  ctx = context(),
): Promise<{ text?: string; structuredContent?: unknown; isError?: boolean }> {
  const tool = tools.get(name);
  assert.ok(tool, name);
  return tool.execute(tool.input.parse(input), ctx);
}

describe('agent tool definitions', () => {
  it('has the three prefixed names, valid for the SDK', () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].toSorted(), [...AGENT_TOOL_NAMES].toSorted());
    for (const name of tools.keys()) {
      assert.match(name, NAME_RULE);
      assert.ok(name.length <= 64);
      assert.ok(name.startsWith('local_decider_'));
    }
  });

  it('says the answer is advisory and not enforced', () => {
    const { tools } = setup();
    assert.match(
      tools.get('local_decider_decide')?.description ?? '',
      /advisory and never enforced/,
    );
  });
});

describe('local_decider_decide', () => {
  it('asks the gateway as harness mcp with the agent id and capped input', async () => {
    const { tools, gateway } = setup();
    const big = 'x'.repeat(50_000);
    const result = await call(tools, 'local_decider_decide', {
      policy: 'turn-outcome',
      input: { request: 'do it', history: big },
    });
    const sent = gateway?.agentCalls[0];
    assert.equal(sent?.name, 'decideAgent');
    assert.equal(sent?.policy, 'turn-outcome');
    assert.equal(sent?.request?.harness, 'mcp');
    assert.equal(sent?.request?.sessionId, 'agent-1');
    assert.deepEqual(sent?.request?.workspace, { cwd: '/work/project' });
    assert.equal(sent?.request?.budgetMs, 15_000);
    assert.ok(String(sent?.request?.input['history']).length < big.length, 'input is capped');
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, agentView());
    assert.equal(
      result.text,
      `turn-outcome: log (shadow, confidence 0.91). Decision ${agentView().decisionId}.`,
    );
  });

  it('maps a failed gateway call, a 403 and a missing gateway to tool errors', async () => {
    const gateway = fakeGateway(() => null);
    gateway.agentDecide = async () => ({ ok: false, error: 'policy not available to agents' });
    const forbidden = await call(setup(gateway).tools, 'local_decider_decide', {
      policy: 'permission',
      input: {},
    });
    assert.deepEqual(forbidden, { isError: true, text: 'policy not available to agents' });
    const none = await call(setup(null).tools, 'local_decider_decide', { policy: 'p', input: {} });
    assert.equal(none.isError, true);
    const throwing = fakeGateway(() => null);
    throwing.agentDecide = async () => {
      throw new Error('boom\nsecond');
    };
    const thrown = await call(setup(throwing).tools, 'local_decider_decide', {
      policy: 'p',
      input: {},
    });
    assert.deepEqual(thrown, { isError: true, text: 'boom second' });
  });

  it('reports a failed-open decision and rejects a bad policy id through the schema', async () => {
    const gateway = fakeGateway(() => null);
    gateway.agentDecide = async () => ({
      ok: true,
      value: agentView({ failedOpen: true, action: 'ask' }),
    });
    const { tools } = setup(gateway);
    const result = await call(tools, 'local_decider_decide', { policy: 'p', input: {} });
    assert.match(result.text ?? '', /failed open/);
    const decide = tools.get('local_decider_decide');
    assert.throws(() => decide?.input.parse({ policy: '../x', input: {} }));
    assert.throws(() => decide?.input.parse({ policy: 'p'.repeat(65), input: {} }));
  });

  it('limits per agent, then globally, with one throttled log line and no gateway call', async () => {
    const { tools, gateway, logs, clock } = setup();
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        (await call(tools, 'local_decider_decide', { policy: 'p', input: {} })).isError,
        undefined,
      );
    }
    const limited = await call(tools, 'local_decider_decide', { policy: 'p', input: {} });
    assert.deepEqual(limited, { isError: true, text: 'rate limited, retry later' });
    await call(tools, 'local_decider_decide', { policy: 'p', input: {} });
    assert.equal(gateway?.agentCalls.length, 10);
    assert.equal(logs.length, 1, 'one log line per minute');
    // Another agent has its own budget until the global one (60) is spent.
    for (let i = 0; i < 50; i += 1) {
      const other = context(`other-${String(i)}`);
      assert.equal(
        (await call(tools, 'local_decider_decide', { policy: 'p', input: {} }, other)).isError,
        undefined,
      );
    }
    const global = await call(
      tools,
      'local_decider_decide',
      { policy: 'p', input: {} },
      context('late'),
    );
    assert.equal(global.text, 'rate limited, retry later');
    clock.now += 61_000;
    assert.equal(
      (await call(tools, 'local_decider_decide', { policy: 'p', input: {} }, context('late')))
        .isError,
      undefined,
    );
  });

  it('allows at most two decides in flight', async () => {
    const gateway = fakeGateway(() => null);
    const release = Promise.withResolvers<void>();
    gateway.agentDecide = async () => {
      await release.promise;
      return { ok: true, value: agentView() };
    };
    const { tools } = setup(gateway);
    const run = (id: string): ReturnType<typeof call> =>
      call(tools, 'local_decider_decide', { policy: 'p', input: {} }, context(id));
    const first = run('a');
    const second = run('b');
    const third = await run('c');
    assert.deepEqual(third, { isError: true, text: 'decider busy, retry later' });
    release.resolve();
    assert.equal((await first).isError, undefined);
    assert.equal((await second).isError, undefined);
    assert.equal((await run('d')).isError, undefined, 'a slot frees up');
  });

  it('passes the tool signal to the gateway call', async () => {
    const gateway = fakeGateway(() => null);
    let seen: AbortSignal | undefined;
    const original = gateway.decideAgent.bind(gateway);
    gateway.decideAgent = async (policy, request, options) => {
      seen = options?.signal;
      return original(policy, request, options);
    };
    const controller = new AbortController();
    await call(
      setup(gateway).tools,
      'local_decider_decide',
      { policy: 'p', input: {} },
      context('a', controller.signal),
    );
    assert.equal(seen, controller.signal);
  });
});

describe('local_decider_explain', () => {
  it('reads the agent view of a decision', async () => {
    const { tools, gateway } = setup();
    const result = await call(tools, 'local_decider_explain', { decisionId: UUID });
    assert.deepEqual(gateway?.agentCalls[0], { name: 'decision', id: UUID });
    assert.match(result.text ?? '', /outcome = done \(confidence 0.91\)/);
    assert.deepEqual(result.structuredContent, agentView());
  });

  it('rejects a non-UUID through the schema', () => {
    const { tools } = setup();
    assert.throws(() => tools.get('local_decider_explain')?.input.parse({ decisionId: 'abc' }));
    assert.throws(() => tools.get('local_decider_explain')?.input.parse({ decisionId: '../x' }));
  });

  it('turns unknown decisions and a remote gateway into tool errors', async () => {
    const gateway = fakeGateway(() => null);
    gateway.agentDecision = async () => ({ ok: false, error: 'unknown decision' });
    const unknown = await call(setup(gateway).tools, 'local_decider_explain', { decisionId: UUID });
    assert.deepEqual(unknown, { isError: true, text: 'unknown decision' });
    gateway.agentDecision = async () => ({
      ok: false,
      error: 'explain needs a loopback gateway\u0007',
    });
    const remote = await call(setup(gateway).tools, 'local_decider_explain', { decisionId: UUID });
    assert.equal(remote.text, 'explain needs a loopback gateway');
  });
});

describe('local_decider_policies', () => {
  it('lists the trimmed policies', async () => {
    const gateway = fakeGateway(() => null);
    const list = [{ id: 'turn-outcome', description: 'd', inputKeys: ['request'], questions: {} }];
    gateway.agentPolicyList = async () => ({ ok: true, value: list });
    const result = await call(setup(gateway).tools, 'local_decider_policies', {});
    assert.deepEqual(JSON.parse(result.text ?? ''), list);
    assert.deepEqual(result.structuredContent, { policies: list });
  });

  it('shares the read limits with explain', async () => {
    const { tools, gateway } = setup();
    for (let i = 0; i < 30; i += 1) {
      await call(
        tools,
        i % 2 === 0 ? 'local_decider_policies' : 'local_decider_explain',
        i % 2 === 0 ? {} : { decisionId: UUID },
      );
    }
    assert.equal(
      (await call(tools, 'local_decider_policies', {})).text,
      'rate limited, retry later',
    );
    assert.equal(gateway?.agentCalls.length, 30);
  });
});

describe('credentials', () => {
  it('never puts a token or the gateway URL in a tool result or definition', async () => {
    const TOKEN = 'T'.repeat(43);
    const gateway = fakeGateway(() => null);
    gateway.agentDecide = async () => ({
      ok: false,
      error: `denied for ${TOKEN}`.replace(TOKEN, 'x'),
    });
    const { tools } = setup(gateway);
    const results = [
      await call(tools, 'local_decider_decide', { policy: 'p', input: {} }),
      await call(tools, 'local_decider_explain', { decisionId: UUID }),
      await call(tools, 'local_decider_policies', {}),
    ];
    const everything = JSON.stringify([
      results,
      [...tools.values()].map((t) => [t.name, t.title, t.description]),
    ]);
    assert.ok(!everything.includes(TOKEN));
    assert.ok(!everything.includes('127.0.0.1'));
    assert.ok(!everything.includes('8765'));
  });
});
