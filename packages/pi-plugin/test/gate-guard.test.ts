import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BREAKER_MS, REPORT_TIMEOUT_MS, USER_BLOCK_REASON } from '../extension/gate.ts';
import type { ToolCallEvent } from '../extension/pi-types.ts';
import {
  bash,
  CONFIG_WRITE,
  CWD,
  fakeCtx,
  fakeGateway,
  harness,
  ID,
  reply,
  returns,
} from './gate-fixtures.ts';

describe('gate: skipped calls', () => {
  it('returns undefined in off mode without asking the gateway', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))), { mode: 'off' });
    assert.equal(
      await h.gate(bash('rm -rf /'), fakeCtx(undefined, { sessionThrows: true }).ctx),
      undefined,
    );
    assert.equal(h.fake.decides.length, 0);
  });

  it('returns undefined for exempt tools without reading the session', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))));
    const { ctx } = fakeCtx(undefined, { sessionThrows: true });
    for (const toolName of ['read', 'grep', 'find', 'ls', 'tool_search', 'codemode']) {
      const event: ToolCallEvent = { type: 'tool_call', toolCallId: 'c', toolName, input: {} };
      assert.equal(await h.gate(event, ctx), undefined, toolName);
    }
    assert.equal(h.fake.decides.length, 0);
  });

  it('gates MCP and unknown tools', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))));
    for (const toolName of ['mcp__srv__tool', 'Bash', 'my_tool']) {
      const event: ToolCallEvent = { type: 'tool_call', toolCallId: 'c', toolName, input: {} };
      const result = await h.gate(event, fakeCtx().ctx);
      assert.equal(result?.block, true, toolName);
    }
    assert.equal(h.fake.decides.length, 3);
  });
});

describe('gate: guard mode decisions', () => {
  it('blocks a hard guard hit without asking the gateway', async () => {
    const h = harness(fakeGateway(returns(reply('allow', true))));
    const result = await h.gate(bash('rm -rf /'), fakeCtx().ctx);
    assert.equal(result?.block, true);
    assert.match(
      result?.reason ?? '',
      /^local-decider guard: .+\. Ask the user before retrying\.$/,
    );
    assert.equal(h.fake.decides.length, 0);
  });

  it('blocks an enforced deny with the decision summary', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))));
    const { ctx, dialogs } = fakeCtx();
    const result = await h.gate(bash('npm publish'), ctx);
    assert.deepEqual(result, {
      block: true,
      reason: `local-decider command-risk: deny (risk=deny, confidence 0.91). Decision ${ID}. Ask the user before retrying.`,
    });
    assert.equal(dialogs.length, 0);
    assert.deepEqual(h.decisions, [ID]);
  });

  it('drops the parenthetical when no answer is usable', async () => {
    for (const answers of [{}, { risk: 'deny' }, { risk: { answer: 'deny' } }]) {
      const h = harness(fakeGateway(returns(reply('deny', true, answers))));
      const result = await h.gate(bash('npm publish'), fakeCtx().ctx);
      assert.equal(
        result?.reason,
        `local-decider command-risk: deny. Decision ${ID}. Ask the user before retrying.`,
      );
    }
  });

  it('sanitizes the question and answer in the reason', async () => {
    const answers = { 'ri\u001b[31msk\n': { answer: 'de\u0007ny', confidence: 1 } };
    const h = harness(fakeGateway(returns(reply('deny', true, answers))));
    const result = await h.gate(bash('npm publish'), fakeCtx().ctx);
    assert.match(result?.reason ?? '', /\(risk=deny, confidence 1\.00\)/);
  });

  for (const action of ['deny', 'ask', 'allow']) {
    it(`runs a shadow ${action} without a dialog`, async () => {
      const h = harness(fakeGateway(returns(reply(action, false))));
      const { ctx, dialogs } = fakeCtx();
      assert.equal(await h.gate(bash('make build'), ctx), undefined);
      assert.equal(dialogs.length, 0);
    });
  }

  it('runs an enforced allow', async () => {
    const h = harness(fakeGateway(returns(reply('allow', true))));
    const { ctx, dialogs } = fakeCtx();
    assert.equal(await h.gate(bash('make build'), ctx), undefined);
    assert.equal(dialogs.length, 0);
  });

  it('sends command-risk with the guard timeout, the signal and the mapped request', async () => {
    const h = harness(fakeGateway(returns(reply('allow', true))));
    const signal = new AbortController().signal;
    await h.gate(bash('make build'), fakeCtx(undefined, { signal }).ctx);
    const [call] = h.fake.decides;
    assert.equal(call?.policy, 'command-risk');
    assert.equal(call?.options.timeoutMs, 1500);
    assert.equal(call?.options.signal, signal);
    assert.equal(call?.request.harness, 'pi');
    assert.equal(call?.request.sessionId, 'sess-1');
    assert.deepEqual(call?.request.workspace, { cwd: CWD });
    assert.deepEqual(call?.request.call, { id: 'call_1' });
    assert.equal(call?.request.input['tool'], 'Bash');
    assert.equal(call?.request.input['command'], 'make build');
  });

  it('hashes a nested codemode call id and sets no agent field', async () => {
    const h = harness(fakeGateway(returns(reply('allow', true))));
    const event: ToolCallEvent = { ...bash('make build', 'call_1/2'), parentToolCallId: 'call_1' };
    await h.gate(event, fakeCtx().ctx);
    const call = h.fake.decides[0]?.request.call;
    assert.match(call?.id ?? '', /^pi-[0-9a-f]{40}$/);
    assert.equal(call !== undefined && 'agent' in call, false);
  });
});

describe('gate: breaker', () => {
  it('runs on a null reply and skips the gateway for 30 s', async () => {
    const h = harness(fakeGateway(returns(null)));
    const { ctx } = fakeCtx();
    assert.equal(await h.gate(bash('make'), ctx), undefined);
    assert.equal(h.fake.decides.length, 1);
    h.clock.t += BREAKER_MS - 1;
    assert.equal(await h.gate(bash('make'), ctx), undefined);
    assert.equal(h.fake.decides.length, 1);
    h.clock.t += 1;
    await h.gate(bash('make'), ctx);
    assert.equal(h.fake.decides.length, 2);
    assert.equal(h.logs.length, 2);
  });

  it('treats a throwing gateway as a failure', async () => {
    const h = harness(
      fakeGateway(async () => {
        throw new Error('boom');
      }),
    );
    const { ctx } = fakeCtx();
    assert.equal(await h.gate(bash('make'), ctx), undefined);
    await h.gate(bash('make'), ctx);
    assert.equal(h.fake.decides.length, 1);
  });

  it('does not open on an aborted turn', async () => {
    const h = harness(fakeGateway(returns(null)));
    const controller = new AbortController();
    controller.abort();
    const { ctx } = fakeCtx(undefined, { signal: controller.signal });
    await h.gate(bash('make'), ctx);
    await h.gate(bash('make'), ctx);
    assert.equal(h.fake.decides.length, 2);
  });

  it('still blocks hard hits and shows guard asks while open', async () => {
    const h = harness(fakeGateway(returns(null)));
    const { ctx, dialogs } = fakeCtx(async () => 'Block');
    await h.gate(bash('make'), ctx);
    assert.equal((await h.gate(bash('rm -rf /'), ctx))?.block, true);
    assert.deepEqual(await h.gate(bash(CONFIG_WRITE), ctx), {
      block: true,
      reason: USER_BLOCK_REASON,
    });
    assert.equal(dialogs.length, 1);
    assert.equal(h.fake.decides.length, 1);
  });
});

describe('gate: dialogs and outcomes', () => {
  it('shows an enforced ask and reports allow', async () => {
    const h = harness(fakeGateway(returns(reply('ask', true))));
    const { ctx, dialogs } = fakeCtx(async () => 'Allow once');
    assert.equal(await h.gate(bash('make deploy'), ctx), undefined);
    assert.equal(dialogs.length, 1);
    const [first, ...rest] = (dialogs[0]?.title ?? '').split('\n');
    assert.equal(first, 'local-decider: allow bash?');
    assert.match(rest.join('\n'), /make deploy/);
    assert.match(rest.join('\n'), /command-risk: ask \(risk=ask, confidence 0\.91\)/);
    assert.equal(dialogs[0]?.opts?.blockedKind, 'permission');
    assert.equal(dialogs[0]?.opts?.timeout, 120_000);
    assert.deepEqual(h.fake.reports, [{ decisionId: ID, outcome: 'allow' }]);
  });

  it('blocks a declined enforced ask and reports decline', async () => {
    const h = harness(fakeGateway(returns(reply('ask', true))));
    const result = await h.gate(bash('make deploy'), fakeCtx(async () => 'Block').ctx);
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
    assert.deepEqual(h.fake.reports, [{ decisionId: ID, outcome: 'decline' }]);
  });

  it('treats Escape as a decline', async () => {
    const h = harness(fakeGateway(returns(reply('ask', true))));
    const result = await h.gate(bash('make deploy'), fakeCtx(async () => undefined).ctx);
    assert.equal(result?.block, true);
  });

  it('runs an enforced ask headless and reports nothing', async () => {
    const h = harness(fakeGateway(returns(reply('ask', true))));
    const { ctx, dialogs } = fakeCtx(undefined, { hasUI: false });
    assert.equal(await h.gate(bash('make deploy'), ctx), undefined);
    assert.equal(dialogs.length, 0);
    assert.equal(h.fake.reports.length, 0);
  });

  it('shows a guard ask without reporting it', async () => {
    for (const [choice, expected] of [
      ['Allow once', undefined],
      ['Block', { block: true, reason: USER_BLOCK_REASON }],
    ] as const) {
      const h = harness(fakeGateway(returns(reply('allow', true))));
      const { ctx, dialogs } = fakeCtx(async () => choice);
      assert.deepEqual(await h.gate(bash(CONFIG_WRITE), ctx), expected);
      assert.match(dialogs[0]?.title ?? '', /local-decider guard: touches local-decider/);
      assert.equal(h.fake.reports.length, 0);
    }
  });

  it('runs a guard ask headless', async () => {
    const h = harness(fakeGateway(returns(null)));
    assert.equal(
      await h.gate(bash(CONFIG_WRITE), fakeCtx(undefined, { hasUI: false }).ctx),
      undefined,
    );
  });

  it('runs a guard ask when the dialog throws', async () => {
    const h = harness(fakeGateway(returns(null)));
    const ctx = fakeCtx(async () => {
      throw new Error('ui');
    }).ctx;
    assert.equal(await h.gate(bash(CONFIG_WRITE), ctx), undefined);
  });

  it('keeps the Block when the report rejects', async () => {
    const h = harness(
      fakeGateway(returns(reply('ask', true)), async () => {
        throw new Error('report');
      }),
    );
    const result = await h.gate(bash('make deploy'), fakeCtx(async () => 'Block').ctx);
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
    assert.deepEqual(h.logs, ['local-decider: outcome report failed']);
  });

  it('keeps the Block when the report throws synchronously', async () => {
    const fake = fakeGateway(returns(reply('ask', true)));
    fake.gateway.reportOutcome = () => {
      throw new Error('sync');
    };
    const h = harness(fake);
    const result = await h.gate(bash('make deploy'), fakeCtx(async () => 'Block').ctx);
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
  });

  it('bounds a hanging report and keeps the Block', async () => {
    const h = harness(fakeGateway(returns(reply('ask', true)), () => new Promise(() => undefined)));
    const started = Date.now();
    const result = await h.gate(bash('make deploy'), fakeCtx(async () => 'Block').ctx);
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { block: true, reason: USER_BLOCK_REASON });
    assert.ok(
      elapsed >= REPORT_TIMEOUT_MS - 50 && elapsed < REPORT_TIMEOUT_MS + 1000,
      `${elapsed}`,
    );
  });
});

describe('gate: fail open', () => {
  it('returns undefined when the config read throws', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))), {
      getConfig: () => {
        throw new Error('config');
      },
    });
    assert.equal(await h.gate(bash('rm -rf /'), fakeCtx().ctx), undefined);
    assert.deepEqual(h.logs, ['local-decider: gate error; the call runs']);
  });

  it('returns undefined when the session cannot be read', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))));
    assert.equal(
      await h.gate(bash('make'), fakeCtx(undefined, { sessionThrows: true }).ctx),
      undefined,
    );
  });

  it('ignores a throwing onDecision observer', async () => {
    const h = harness(fakeGateway(returns(reply('deny', true))), {
      onDecision: () => {
        throw new Error('observer');
      },
    });
    assert.equal((await h.gate(bash('npm publish'), fakeCtx().ctx))?.block, true);
  });
});
