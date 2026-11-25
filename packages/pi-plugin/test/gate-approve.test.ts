import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BREAKER_MS,
  ERROR_BLOCK_REASON,
  HEADLESS_BLOCK_REASON,
  USER_BLOCK_REASON,
} from '../extension/gate.ts';
import type { PiContext, ToolCallEvent } from '../extension/pi-types.ts';
import {
  bash,
  CONFIG_WRITE,
  fakeCtx,
  fakeGateway,
  harness,
  ID,
  message,
  reply,
  returns,
  toolEvent,
  type CtxOptions,
  type FakeCtx,
  type Harness,
} from './gate-fixtures.ts';

const TASK = [message('user', 'fix the build'), message('assistant', 'on it')];
const ALLOW = reply('allow', true, { verdict: { answer: 'allow', confidence: 0.97 } });

function approve(decide = returns(ALLOW), extra: Parameters<typeof harness>[1] = {}): Harness {
  return harness(fakeGateway(decide), { mode: 'approve', ...extra });
}

/** A context with a task and recent user context, unless `entries` overrides it. */
function withTask(choice: string | undefined = 'Allow once', extra: CtxOptions = {}): FakeCtx {
  return fakeCtx(async () => choice, { entries: TASK, ...extra });
}

const ELIGIBLE: [string, ToolCallEvent][] = [
  ['bash', bash('make build')],
  ['edit', toolEvent('edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] })],
  ['write', toolEvent('write', { path: 'src/b.ts', content: 'x' })],
];

describe('approve: auto-allow bar', () => {
  for (const [name, event] of ELIGIBLE) {
    it(`runs an eligible ${name} call without a dialog`, async () => {
      const h = approve();
      const { ctx, dialogs } = withTask();
      assert.equal(await h.gate(event, ctx), undefined);
      assert.equal(dialogs.length, 0);
      assert.equal(h.fake.reports.length, 0);
    });
  }

  it('runs an eligible call headless', async () => {
    const h = approve();
    assert.equal(
      await h.gate(bash('make build'), withTask(undefined, { hasUI: false }).ctx),
      undefined,
    );
  });

  it('sends permission with the approve timeout, task and history', async () => {
    const h = approve();
    await h.gate(bash('make build'), withTask().ctx);
    const [call] = h.fake.decides;
    assert.equal(call?.policy, 'permission');
    assert.equal(call?.options.timeoutMs, 10_000);
    assert.equal(call?.request.harness, 'pi');
    assert.equal(call?.request.input['tool'], 'Bash');
    assert.match(String(call?.request.input['task']), /fix the build/);
    assert.match(String(call?.request.input['history']), /assistant: on it/);
    assert.deepEqual(call?.request.call, { id: 'call_1' });
  });

  it('hashes a nested call id and sets no agent field', async () => {
    const h = approve();
    const event: ToolCallEvent = { ...bash('make build', 'call_1/2'), parentToolCallId: 'call_1' };
    await h.gate(event, withTask().ctx);
    const call = h.fake.decides[0]?.request.call;
    assert.match(call?.id ?? '', /^pi-[0-9a-f]{40}$/);
    assert.equal(call !== undefined && 'agent' in call, false);
  });

  const INELIGIBLE: [string, ToolCallEvent][] = [
    ['an MCP tool', toolEvent('mcp__srv__tool', { q: 1 })],
    ['an unknown tool', toolEvent('my_tool', {})],
    ['a capitalised Bash', toolEvent('Bash', { command: 'make' })],
    ['powershell', toolEvent('powershell', { command: 'Get-ChildItem' })],
    ['bash with no command', toolEvent('bash', {})],
    ['a guard ask', bash(CONFIG_WRITE)],
  ];
  for (const [name, event] of INELIGIBLE) {
    it(`asks for ${name} even on an enforced allow`, async () => {
      const h = approve();
      const { ctx, dialogs } = withTask('Block');
      assert.deepEqual(await h.gate(event, ctx), { block: true, reason: USER_BLOCK_REASON });
      assert.equal(dialogs.length, 1);
      assert.match(dialogs[0]?.title ?? '', /local-decider permission: allow \(verdict=allow/);
      assert.deepEqual(h.fake.reports, [{ decisionId: ID, outcome: 'decline' }]);
    });
  }

  it('says why a guard ask was not auto-allowed', async () => {
    const h = approve();
    const { ctx, dialogs } = withTask();
    await h.gate(bash(CONFIG_WRITE), ctx);
    assert.match(dialogs[0]?.title ?? '', /local-decider guard: touches local-decider/);
  });

  it('asks on win32', async () => {
    const h = approve(returns(ALLOW), { platform: 'win32' });
    const { ctx, dialogs } = withTask();
    assert.equal(await h.gate(bash('make build'), ctx), undefined);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0]?.title ?? '', /Only checked shell and edit calls/);
  });

  const NO_CONTEXT: [string, CtxOptions][] = [
    ['no session entries', { entries: [] }],
    ['only assistant messages', { entries: [message('assistant', 'hello')] }],
    ['unreadable entries', {}],
  ];
  for (const [name, extra] of NO_CONTEXT) {
    it(`asks with ${name}`, async () => {
      const h = approve();
      const { ctx, dialogs } = fakeCtx(async () => 'Allow once', extra);
      assert.equal(await h.gate(bash('make build'), ctx), undefined);
      assert.equal(dialogs.length, 1);
      assert.match(dialogs[0]?.title ?? '', /no task or recent user message/);
    });
  }

  it('asks on an enforced allow that carries an error', async () => {
    const h = approve(returns({ ...ALLOW, error: 'engine fallback' }));
    const { ctx, dialogs } = withTask();
    await h.gate(bash('make build'), ctx);
    assert.equal(dialogs.length, 1);
  });

  for (const action of ['allow', 'deny', 'ask']) {
    it(`asks on a shadow ${action} and reports the answer`, async () => {
      const h = approve(returns(reply(action, false)));
      const { ctx, dialogs } = withTask();
      assert.equal(await h.gate(bash('make build'), ctx), undefined);
      assert.match(dialogs[0]?.title ?? '', /\(not enforced\)/);
      assert.deepEqual(h.fake.reports, [{ decisionId: ID, outcome: 'allow' }]);
    });
  }
});

describe('approve: blocks', () => {
  it('blocks a hard guard hit without asking the gateway', async () => {
    const h = approve();
    const result = await h.gate(bash('rm -rf /'), withTask().ctx);
    assert.match(
      result?.reason ?? '',
      /^local-decider guard: .+\. Ask the user before retrying\.$/,
    );
    assert.equal(h.fake.decides.length, 0);
  });

  it('blocks an enforced deny without a dialog', async () => {
    const h = approve(returns(reply('deny', true)));
    const { ctx, dialogs } = withTask();
    assert.deepEqual(await h.gate(toolEvent('mcp__srv__tool', {}), ctx), {
      block: true,
      reason: `local-decider permission: deny (risk=deny, confidence 0.91). Decision ${ID}. Ask the user before retrying.`,
    });
    assert.equal(dialogs.length, 0);
  });

  it('shows an enforced ask and reports allow', async () => {
    const h = approve(returns(reply('ask', true)));
    const { ctx, dialogs } = withTask();
    assert.equal(await h.gate(bash('make deploy'), ctx), undefined);
    assert.equal(dialogs[0]?.opts?.blockedKind, 'permission');
    assert.equal(dialogs[0]?.opts?.timeout, 120_000);
    assert.deepEqual(h.fake.reports, [{ decisionId: ID, outcome: 'allow' }]);
  });

  it('blocks headless when a dialog is needed, and reports nothing', async () => {
    const h = approve(returns(reply('ask', true)));
    const { ctx, dialogs } = withTask(undefined, { hasUI: false });
    assert.deepEqual(await h.gate(bash('make deploy'), ctx), {
      block: true,
      reason: HEADLESS_BLOCK_REASON,
    });
    assert.equal(dialogs.length, 0);
    assert.equal(h.fake.reports.length, 0);
  });

  it('blocks when the dialog throws', async () => {
    const h = approve(returns(reply('ask', true)));
    const ctx = fakeCtx(
      async () => {
        throw new Error('ui');
      },
      { entries: TASK },
    ).ctx;
    assert.equal((await h.gate(bash('make deploy'), ctx))?.block, true);
  });

  it('keeps the Block when the report rejects', async () => {
    const h = harness(
      fakeGateway(returns(reply('ask', true)), async () => {
        throw new Error('report');
      }),
      { mode: 'approve' },
    );
    const result = await h.gate(bash('make deploy'), withTask('Block').ctx);
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
  });
});

describe('approve: gateway down', () => {
  it('shows the dialog without reporting', async () => {
    const h = approve(returns(null));
    const { ctx, dialogs } = withTask();
    assert.equal(await h.gate(bash('make build'), ctx), undefined);
    assert.match(dialogs[0]?.title ?? '', /no decision \(gateway unavailable\)/);
    assert.equal(h.fake.reports.length, 0);
  });

  it('blocks headless', async () => {
    const h = approve(returns(null));
    const result = await h.gate(bash('make build'), withTask(undefined, { hasUI: false }).ctx);
    assert.deepEqual(result, { block: true, reason: HEADLESS_BLOCK_REASON });
  });

  it('skips the gateway while the breaker is open and still asks', async () => {
    const h = approve(returns(null));
    const { ctx, dialogs } = withTask('Block');
    await h.gate(bash('make build'), ctx);
    assert.equal((await h.gate(bash('make build'), ctx))?.block, true);
    assert.equal(h.fake.decides.length, 1);
    assert.equal(dialogs.length, 2);
    h.clock.t += BREAKER_MS;
    await h.gate(bash('make build'), ctx);
    assert.equal(h.fake.decides.length, 2);
  });
});

describe('approve: internal errors', () => {
  it('asks the user, and runs on Allow', async () => {
    const h = approve();
    const { ctx, dialogs } = withTask('Allow once', { sessionThrows: true });
    assert.equal(await h.gate(bash('make build'), ctx), undefined);
    assert.match(dialogs[0]?.title ?? '', /the gate failed on this call/);
    assert.deepEqual(h.logs, ['local-decider: gate error; asking the user']);
  });

  it('blocks on Block', async () => {
    const h = approve();
    const result = await h.gate(bash('make build'), withTask('Block', { sessionThrows: true }).ctx);
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
  });

  it('blocks headless', async () => {
    const h = approve();
    const ctx = withTask(undefined, { sessionThrows: true, hasUI: false }).ctx;
    assert.deepEqual(await h.gate(bash('make build'), ctx), {
      block: true,
      reason: HEADLESS_BLOCK_REASON,
    });
  });

  it('blocks when even the dialog cannot be reached', async () => {
    const h = approve();
    const base = withTask(undefined, { sessionThrows: true }).ctx;
    const ctx: PiContext = Object.defineProperty({ ...base }, 'hasUI', {
      get: () => {
        throw new Error('ui state');
      },
    });
    assert.deepEqual(await h.gate(bash('make build'), ctx), {
      block: true,
      reason: ERROR_BLOCK_REASON,
    });
  });

  it('still fails open when the config cannot be read', async () => {
    const h = approve(returns(null), {
      getConfig: () => {
        throw new Error('config');
      },
    });
    assert.equal(
      await h.gate(bash('make build'), withTask(undefined, { hasUI: false }).ctx),
      undefined,
    );
  });
});
