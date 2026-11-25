import {
  buildPermissionInput,
  canonicalSubject,
  capInput,
  projectLabel,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { SessionContext } from '../extension/context.ts';
import { callId, commandRiskRequest, permissionRequest } from '../extension/mapping.ts';

const sc: SessionContext = {
  sessionId: 's1',
  cwd: '/work/app',
  task: 'First request: ship it',
  history: 'user: ship it',
  hasRecentUserContext: true,
};
const bash = { kind: 'shell', name: 'bash', guardTool: 'Bash', command: 'npm test' } as const;
const input = { command: 'npm test', timeout: 5 };

test('callId keeps valid ids and hashes nested ones', () => {
  assert.equal(callId('call_abc-123'), 'call_abc-123');
  const nested = 'call_abc/2';
  const id = callId(nested);
  assert.equal(id, `pi-${createHash('sha256').update(nested).digest('hex').slice(0, 40)}`);
  assert.match(id, /^[\w-]{1,128}$/);
  assert.match(callId('x'.repeat(200)), /^pi-[0-9a-f]{40}$/);
});

test('command-risk request has the hooks keys', () => {
  const r = commandRiskRequest(bash, input, sc, 1500, 'call_1');
  assert.deepEqual(r, {
    harness: 'pi',
    sessionId: 's1',
    input: capInput({ project: projectLabel('/work/app'), tool: 'Bash', command: 'npm test' }),
    workspace: { cwd: '/work/app' },
    call: { id: 'call_1' },
    budgetMs: 1000,
  });
});

test('command-risk falls back to the raw input and nested ids are hashed', () => {
  const r = commandRiskRequest({ kind: 'mcp', name: 'mcp__s__t' }, { a: 1 }, sc, 100, 'p/1');
  assert.deepEqual(r.input['command'], { a: 1 });
  assert.equal(r.input['tool'], 'mcp__s__t');
  assert.equal(r.budgetMs, 100);
  assert.match(r.call?.id ?? '', /^pi-[0-9a-f]{40}$/);
});

test('permission request builds the shared input with the hooks subject for Bash', () => {
  const r = permissionRequest(bash, input, sc, 10_000, 'call_1');
  const hooksSubject = canonicalSubject('Bash', { command: 'npm test' }, '/work/app');
  assert.equal(hooksSubject, 'shell: npm test');
  assert.deepEqual(
    r.input,
    buildPermissionInput({
      cwd: '/work/app',
      tool: 'Bash',
      request: input,
      subject: hooksSubject,
      history: sc.history,
      task: sc.task,
    }),
  );
  assert.equal(r.input['subject'], hooksSubject);
  assert.equal(r.budgetMs, 9500);
  assert.equal(r.harness, 'pi');
});

test('permission subject for Edit and Write uses the path', () => {
  const edit = permissionRequest(
    { kind: 'edit', name: 'edit', guardTool: 'Edit', path: '/work/app/src/a.ts' },
    { path: '/work/app/src/a.ts', edits: [] },
    sc,
    10_000,
    'c',
  );
  assert.equal(
    edit.input['subject'],
    canonicalSubject('Edit', { file_path: 'src/a.ts' }, '/work/app'),
  );
  const write = permissionRequest(
    { kind: 'edit', name: 'write', guardTool: 'Write', path: 'src/b.ts' },
    { path: 'src/b.ts', content: '' },
    sc,
    10_000,
    'c',
  );
  assert.equal(write.input['tool'], 'Write');
  assert.equal(
    write.input['subject'],
    canonicalSubject('Write', { file_path: 'src/b.ts' }, '/work/app'),
  );
});

test('permission request omits empty history and task', () => {
  const r = permissionRequest(
    { kind: 'mcp', name: 'mcp__s__t' },
    { x: 1 },
    { sessionId: 's', cwd: '/w', hasRecentUserContext: false },
    10_000,
    'c',
  );
  assert.equal('history' in r.input, false);
  assert.equal('task' in r.input, false);
});
