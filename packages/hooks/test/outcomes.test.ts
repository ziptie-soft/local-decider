import type { DecideResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseEvent } from '../src/mapping.ts';
import { PENDING_TTL_MS, claimPending, pendingDir, writePending } from '../src/pending.ts';
import { run, type Env } from '../src/run.ts';
import type { TranscriptSlice } from '../src/transcript.ts';

const context = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the tests' } })}\n`;
const readContext = (): TranscriptSlice => ({ head: context, tail: context });

const SECRET = 'npm test --token=hunter2-secret';
const BASE = { session_id: 's-1', cwd: '/work/app', transcript_path: '/t.jsonl' };
const REQUEST = { ...BASE, tool_name: 'Bash', tool_input: { command: SECRET } };
const POST = { ...REQUEST, tool_response: { stdout: 'ok' }, tool_use_id: 'toolu_1' };

function response(action: string, enforced: boolean, decisionId = 'd-1'): DecideResponse {
  return {
    decisionId,
    policy: 'permission',
    mode: enforced ? 'act' : 'shadow',
    action,
    enforced,
    answers: {},
    rule: 0,
    engine: 'test',
    model: 'm',
    latencyMs: 1,
    cached: false,
  };
}

let home = '';
let env: Env = {};
let dir = '';
let clock = 1_800_000_000_000;
let reported: string[] = [];

const now = (): number => clock;
const reportOutcome = async (id: string): Promise<boolean> => {
  reported.push(id);
  return true;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ld-outcomes-'));
  env = { LOCAL_DECIDER_HOME: home };
  dir = join(home, 'hooks', 'pending');
  reported = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function permission(
  res: DecideResponse | null,
  hook: Record<string, unknown> = REQUEST,
  harness = 'claude',
  runEnv: Env = env,
): Promise<string> {
  const out = await run(harness, 'PermissionRequest', JSON.stringify(hook), runEnv, {
    decide: async () => res,
    readTranscript: readContext,
    outcomes: { now },
  });
  return out.stdout;
}

async function posted(hook: Record<string, unknown> = POST, harness = 'claude'): Promise<string> {
  const out = await run(harness, 'PostToolUse', JSON.stringify(hook), env, {
    decide: async () => {
      throw new Error('PostToolUse must not run a policy');
    },
    outcomes: { now, reportOutcome },
  });
  assert.equal(out.exitCode, 0);
  return out.stdout;
}

const files = (): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

describe('PostToolUse outcomes', () => {
  it('is a known event', () => {
    assert.equal(parseEvent('PostToolUse'), 'PostToolUse');
    assert.equal(parseEvent('post-tool-use'), 'PostToolUse');
  });

  it('resolves the pending dir like the gateway', () => {
    assert.equal(pendingDir({ LOCAL_DECIDER_HOME: '/h' }), '/h/hooks/pending');
    assert.equal(pendingDir({ HOME: '/u', XDG_DATA_HOME: '/x' }), '/x/local-decider/hooks/pending');
    assert.equal(pendingDir({ HOME: '/u' }), '/u/.local/share/local-decider/hooks/pending');
    assert.equal(pendingDir({}), undefined);
    // Empty values count as set, as in the gateway's resolvePaths.
    assert.equal(pendingDir({ HOME: '/u', LOCAL_DECIDER_HOME: '' }), 'hooks/pending');
    assert.equal(pendingDir({ HOME: '/u', XDG_DATA_HOME: '' }), 'local-decider/hooks/pending');
  });

  it('round-trips a user approval as outcome allow', async () => {
    assert.equal(await permission(response('ask', true)), '');
    assert.equal(files().length, 1);
    assert.equal(await posted(), '');
    assert.deepEqual(reported, ['d-1']);
    assert.deepEqual(files(), []);
    await posted();
    assert.deepEqual(reported, ['d-1'], 'claimed once');
  });

  it('matches non-shell tools ignoring description', async () => {
    const tool = { ...BASE, tool_name: 'mcp__s__t', tool_input: { q: 1, description: 'a' } };
    await permission(response('abstain', false), tool);
    await posted({ ...tool, tool_input: { q: 1, description: 'b' } });
    assert.deepEqual(reported, ['d-1']);
  });

  it('does not match another session or subject', async () => {
    await permission(response('ask', true));
    await posted({ ...POST, session_id: 's-2' });
    await posted({ ...POST, tool_input: { command: 'npm run build' } });
    assert.deepEqual(reported, []);
    assert.equal(files().length, 1);
  });

  it('writes nothing for an enforced allow, auto mode, codex or no answer', async () => {
    assert.notEqual(await permission(response('allow', true)), '');
    await permission(response('ask', true), { ...REQUEST, permission_mode: 'auto' });
    await permission(response('ask', true), REQUEST, 'codex');
    await permission(null);
    assert.deepEqual(files(), []);
    await posted(POST, 'codex');
    assert.deepEqual(reported, []);
  });

  it('writes nothing when the host runs the permission policy', async () => {
    await permission(response('ask', true), REQUEST, 'claude', {
      ...env,
      LOCAL_DECIDER_HOST_POLICIES: 'permission',
    });
    assert.deepEqual(files(), []);
  });

  it('posts once for two concurrent claims', async () => {
    await permission(response('ask', true));
    await Promise.all([posted(), posted(), posted()]);
    assert.deepEqual(reported, ['d-1']);
    const key = { session: 's-1', subject: 'shell: x' };
    writePending(dir, key, 'd-9', clock);
    const claims = [claimPending(dir, key, clock), claimPending(dir, key, clock)];
    assert.deepEqual(claims, ['d-9', undefined]);
  });

  it('replaces older entries for the same key and claims the newest', async () => {
    const key = { session: 's-1', subject: 'shell: x' };
    writePending(dir, key, 'd-old', clock);
    writePending(dir, key, 'd-new', clock + 1000);
    assert.equal(files().length, 1);
    assert.equal(claimPending(dir, key, clock + 1000), 'd-new');
    assert.deepEqual(files(), []);
  });

  it('claims the newest of several live entries', () => {
    // Racing writers can leave several entries for one key; craft them next to a real one.
    const key = { session: 's-1', subject: 'shell: x' };
    writePending(dir, key, 'd-old', clock);
    const [first = ''] = files();
    const prefix = first.split('-').slice(0, 2).join('-');
    const add = (id: string, stamp: number): void => {
      const body = JSON.stringify({ v: 1, decisionId: id });
      writeFileSync(join(dir, `${prefix}-${String(stamp)}-0000000a.json`), body);
    };
    add('d-new', clock + 2000);
    add('d-mid', clock + 1000);
    const claims = [1, 2, 3].map(() => claimPending(dir, key, clock + 2000));
    assert.deepEqual(claims, ['d-new', 'd-mid', 'd-old']);
  });

  it('a second prompt for the same subject replaces the first', async () => {
    await permission(response('ask', true, 'd-first'));
    clock += 1000;
    await permission(response('ask', true, 'd-second'));
    assert.equal(files().length, 1);
    await posted();
    await posted();
    assert.deepEqual(reported, ['d-second']);
  });

  it('posts nothing when a denied prompt is followed by a run after the TTL', async () => {
    await permission(response('ask', true, 'd-denied'));
    clock += PENDING_TTL_MS + 1;
    await posted();
    assert.deepEqual(reported, []);
  });

  it('purges expired entries without posting them', async () => {
    await permission(response('ask', true));
    clock += PENDING_TTL_MS + 1;
    await posted();
    assert.deepEqual(reported, []);
    await run('claude', 'SessionStart', JSON.stringify(BASE), env, {
      health: async () => ({ status: 'ok' }),
      outcomes: { now },
    });
    assert.deepEqual(files(), []);
  });

  it('purges expired entries on write', async () => {
    await permission(response('ask', true, 'd-a'));
    clock += PENDING_TTL_MS + 1;
    await permission(response('ask', true, 'd-b'), { ...REQUEST, session_id: 's-2' });
    assert.equal(files().length, 1);
  });

  it('stores only the decision id, with private modes', async () => {
    await permission(response('ask', true));
    const [name = ''] = files();
    assert.match(name, /^[0-9a-f]{16}-[0-9a-f]{24}-\d+-[0-9a-f]{8}\.json$/);
    const text = readFileSync(join(dir, name), 'utf8');
    assert.deepEqual(JSON.parse(text), { v: 1, decisionId: 'd-1' });
    assert.equal(text.includes('hunter2'), false);
    assert.equal(name.includes('s-1'), false);
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('fails open when the store is unusable or the report throws', async () => {
    writeFileSync(join(home, 'hooks'), 'not a directory');
    assert.equal(await permission(response('ask', true)), '');
    assert.equal(await posted(), '');
    rmSync(join(home, 'hooks'));
    await permission(response('ask', true));
    const out = await run('claude', 'PostToolUse', JSON.stringify(POST), env, {
      outcomes: {
        now,
        reportOutcome: async () => {
          throw new Error('gateway down');
        },
      },
    });
    assert.deepEqual(out, { stdout: '', exitCode: 0 });
    assert.equal(await posted('{not json' as unknown as Record<string, unknown>), '');
  });
});
