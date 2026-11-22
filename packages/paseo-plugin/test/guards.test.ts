import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type { AgentPermissionRequest, AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import { AGENT_PROVIDER_DEFINITIONS } from '@getpaseo/protocol/provider-manifest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Background } from '../server/background.ts';
import { ThrottledLog } from '../server/limits.ts';
import { effectiveTier, guardMode, PROVIDER_MODES } from '../server/mode-tiers.ts';
import { createPermissionHandlers } from '../server/permission.ts';
import { createTurnHandler } from '../server/turn.ts';
import { ctx, deps, fakeGateway, fakePaseo, response, settings, withConfigDir } from './fakes.ts';

const agentOf = (id: string, cwd = '/p'): PluginHookAgent => ({
  id,
  workspaceId: 'w1',
  parentAgentId: null,
  provider: 'claude',
  cwd,
  title: null,
});

const request = (
  id: string,
  input: unknown = { command: 'ls' },
  name = 'Bash',
): AgentPermissionRequest =>
  ({ id, provider: 'claude', name, kind: 'tool', input }) as AgentPermissionRequest;

const items: { item: AgentTimelineItem; turnId?: string }[] = [
  { item: { type: 'user_message', text: 'Add tests' }, turnId: 't1' },
  { item: { type: 'assistant_message', text: 'Done.' }, turnId: 't1' },
];

const actMode = settings({
  modes: { 'turn-outcome': 'act', 'permission': 'act', 'routing': 'shadow' },
});
const allow = (): ReturnType<typeof response> =>
  response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true });

describe('ThrottledLog', () => {
  it('logs once per interval and counts the suppressed lines', () => {
    const clock = { t: 0 };
    const lines: string[] = [];
    const throttle = new ThrottledLog(1000, () => clock.t);
    for (let i = 0; i < 4; i += 1) {
      throttle.emit((m) => lines.push(m), 'x');
    }
    assert.deepEqual(lines, ['x']);
    clock.t = 1000;
    throttle.emit((m) => lines.push(m), 'x');
    assert.deepEqual(lines, ['x', 'x (3 similar suppressed)']);
  });
});

describe('mode tiers', () => {
  it('match the provider manifest', () => {
    for (const [provider, mine] of Object.entries(PROVIDER_MODES)) {
      const def = AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === provider);
      assert.ok(def !== undefined, `${provider} is a built-in provider`);
      const tiers = Object.fromEntries(def.modes.map((m) => [m.id, m.colorTier]));
      const names = { planning: 0, safe: 1, moderate: 2, dangerous: 3 } as const;
      const expected = Object.fromEntries(
        Object.entries(tiers).map(([id, tier]) => [id, names[tier as keyof typeof names]]),
      );
      assert.deepEqual(mine.modes, expected, provider);
      assert.equal(mine.defaultModeId, def.defaultModeId ?? null, `${provider} default`);
    }
  });

  it('ranks the default mode of a provider when none is set', () => {
    assert.equal(effectiveTier('claude', undefined), 2);
    assert.equal(effectiveTier('claude', 'bypassPermissions'), 3);
    assert.equal(effectiveTier('pi', undefined), null);
    assert.equal(effectiveTier('unknown', 'x'), null);
  });

  it('keeps, drops or skips', () => {
    const claude = { provider: 'claude', model: 'opus' };
    const keep = (modeId: string): ReturnType<typeof guardMode> =>
      guardMode(claude, { provider: 'claude', model: 'haiku', modeId });
    assert.equal(keep('').kind, 'keep');
    assert.equal(keep('plan').kind, 'keep');
    assert.equal(keep('auto').kind, 'keep');
    assert.equal(keep('bypassPermissions').kind, 'dropped');
    assert.equal(
      guardMode(claude, { provider: 'codex', model: 'gpt', modeId: 'full-access' }).kind,
      'skip',
    );
    assert.equal(
      guardMode(claude, { provider: 'codex', model: 'gpt', modeId: 'auto' }).kind,
      'keep',
    );
    // An unknown tier allows only a model change on the same provider.
    const pi = { provider: 'pi', model: 'a' };
    assert.equal(guardMode(pi, { provider: 'pi', model: 'b', modeId: '' }).kind, 'keep');
    assert.equal(guardMode(pi, { provider: 'pi', model: 'b', modeId: 'x' }).kind, 'dropped');
  });
});

type Ask = (agent: PluginHookAgent, id: string) => Promise<ReturnType<typeof fakePaseo>>;

const setup = (
  options: Parameters<typeof createPermissionHandlers>[2] = {},
): { gw: ReturnType<typeof fakeGateway>; d: ReturnType<typeof deps>; ask: Ask } => {
  const bg = new Background();
  const gw = fakeGateway(allow);
  const d = deps(actMode, gw);
  const handlers = createPermissionHandlers(d, bg, options);
  const ask: Ask = async (agent, id) => {
    const req = request(id);
    const paseo = fakePaseo(items);
    await handlers.before({ agent, request: req }, ctx(paseo));
    await bg.idle();
    return paseo;
  };
  return { gw, d, ask };
};

describe('permission limits', () => {
  it('stops deciding for one agent after 20 requests a minute', async () => {
    const clock = { t: 0 };
    const { gw, d, ask } = setup({ now: () => clock.t });
    for (let i = 0; i < 21; i += 1) {
      await ask(agentOf('a1'), `r${String(i)}`);
    }
    assert.equal(gw.calls.length, 20);
    assert.ok(d.logs.some((l) => l.includes('permission skipped: rate limit')));
    clock.t = 60_001;
    await ask(agentOf('a1'), 'again');
    assert.equal(gw.calls.length, 21);
  });
});

describe('permission global limit', () => {
  it('stops after 120 across agents', async () => {
    const bg = new Background();
    const gw = fakeGateway(allow);
    const handlers = createPermissionHandlers(deps(actMode, gw), bg, { now: () => 0 });
    for (let i = 0; i < 125; i += 1) {
      const agent = agentOf(`agent${String(Math.floor(i / 10))}`);
      await handlers.before({ agent, request: request(`r${String(i)}`) }, ctx(fakePaseo(items)));
      await bg.idle();
    }
    assert.equal(gw.calls.length, 120);
  });
});

describe('permission deadline', () => {
  it('skips decide when the timeline fetch spends the deadline', async () => {
    const clock = { t: 0 };
    const bg = new Background();
    const gw = fakeGateway(allow);
    const d = deps(actMode, gw);
    const handlers = createPermissionHandlers(d, bg, { now: () => clock.t });
    const paseo = fakePaseo(items);
    paseo.agent.timeline.refetch = async () => {
      clock.t += 9500;
      return { entries: items };
    };
    await handlers.before({ agent: agentOf('a1'), request: request('r1') }, ctx(paseo));
    await bg.idle();
    assert.equal(gw.calls.length, 0);
    assert.equal(paseo.agent.responses.length, 0);
    assert.ok(d.logs.some((l) => l.includes('deadline spent before decide')));
  });

  it('hands the remaining time to decide', async () => {
    const clock = { t: 0 };
    const bg = new Background();
    const gw = fakeGateway(allow);
    const handlers = createPermissionHandlers(deps(actMode, gw), bg, { now: () => clock.t });
    const paseo = fakePaseo(items);
    paseo.agent.timeline.refetch = async () => {
      clock.t += 2000;
      return { entries: items };
    };
    await handlers.before({ agent: agentOf('a1'), request: request('r1') }, ctx(paseo));
    await bg.idle();
    assert.equal(gw.calls[0]?.timeoutMs, 8000);
  });

  it('gives up on a hung decision: no allow, no row', async () => {
    const bg = new Background();
    const gw = fakeGateway(async () => new Promise(() => {}));
    const handlers = createPermissionHandlers(deps(actMode, gw), bg, {
      deadlineMs: 60,
      minDecideMs: 10,
    });
    const paseo = fakePaseo(items);
    await handlers.before({ agent: agentOf('a1'), request: request('r1') }, ctx(paseo));
    await bg.idle();
    assert.equal(paseo.agent.responses.length, 0);
    assert.equal(paseo.agent.appended.length, 0);
  });
});

const run = async (cwd: string, req: AgentPermissionRequest): Promise<number> => {
  const bg = new Background();
  const handlers = createPermissionHandlers(deps(actMode, fakeGateway(allow)), bg);
  const paseo = fakePaseo(items);
  await handlers.before({ agent: agentOf('a1', cwd), request: req }, ctx(paseo));
  await bg.idle();
  return paseo.agent.responses.length;
};

describe('permission config-dir refusal', () => {
  it('never auto-allows in, or a path into, the config directory', async () => {
    await withConfigDir('/cfg/local-decider', async () => {
      assert.equal(await run('/cfg/local-decider', request('r1')), 0);
      assert.equal(await run('/cfg/local-decider/sub', request('r2')), 0);
      assert.equal(
        await run('/p', request('r3', { file_path: '/cfg/local-decider/policies/x.yaml' }, 'Edit')),
        0,
      );
      assert.equal(await run('/p', request('r4')), 1);
    });
  });
});

const edit = (file: string): AgentPermissionRequest => request('e', { file_path: file }, 'Edit');
const patch = (target: string): AgentPermissionRequest =>
  request(
    'p',
    { command: `*** Begin Patch\n*** Update File: ${target}\n@@\n-a\n+b\n` },
    'apply_patch',
  );

describe('permission config-dir refusal, beyond the obvious', () => {
  it('refuses shell words, patch targets, `..` and relative paths that reach it', async () => {
    await withConfigDir('/cfg/local-decider', async () => {
      assert.equal(
        await run('/cfg', request('s1', { command: 'cat /cfg/local-decider/config.yaml' })),
        0,
      );
      assert.equal(
        await run('/cfg', request('s2', { command: 'echo x > local-decider/config.yaml' })),
        0,
      );
      assert.equal(
        await run('/cfg', request('s3', { command: 'sed -i s/a/b/ --in=local-decider/x' })),
        0,
      );
      assert.equal(await run('/cfg', patch('local-decider/config.yaml')), 0);
      assert.equal(await run('/cfg/other', edit('../local-decider/config.yaml')), 0);
      assert.equal(await run('/cfg', edit('local-decider/policies/x.yaml')), 0);
      assert.equal(await run('/cfg', edit('/cfg/other/../local-decider/x')), 0);
    });
  });

  it('does not confuse a sibling that shares the prefix', async () => {
    await withConfigDir('/cfg/local-decider', async () => {
      assert.equal(await run('/cfg', edit('/cfg/local-decider2/x')), 1);
      assert.equal(await run('/cfg', request('s4', { command: 'cat local-decider-notes/x' })), 1);
      assert.equal(await run('/cfg', patch('local-decider2/config.yaml')), 1);
    });
  });

  it('refuses a path that reaches it through a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ld-cfg-'));
    try {
      const cfg = join(root, 'cfg');
      const project = join(root, 'project');
      mkdirSync(cfg);
      mkdirSync(project);
      symlinkSync(cfg, join(project, 'link'));
      await withConfigDir(cfg, async () => {
        assert.equal(await run(project, edit(join(project, 'link', 'policies', 'x.yaml'))), 0);
        assert.equal(await run(project, request('s5', { command: 'cat link/config.yaml' })), 0);
        assert.equal(await run(join(project, 'link'), request('s6')), 0);
        assert.equal(await run(project, edit(join(project, 'notes.md'))), 1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('agent.turn.after global limit', () => {
  it('stops after 60 turns a minute across agents', async () => {
    const bg = new Background();
    const gw = fakeGateway(() => response({ action: 'notify', mode: 'act', enforced: true }));
    const d = deps(actMode, gw);
    const handler = createTurnHandler(d, { background: bg });
    for (let i = 0; i < 65; i += 1) {
      const agent = agentOf(`agent${String(i)}`);
      await handler({ agent, turnId: 't1', outcome: { kind: 'completed' } }, ctx(fakePaseo(items)));
      await bg.idle();
    }
    assert.equal(gw.calls.length, 60);
    assert.ok(d.logs.some((l) => l.includes('turn-outcome skipped: rate limit')));
  });
});
