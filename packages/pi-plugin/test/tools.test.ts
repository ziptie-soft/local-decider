import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyTool, mappedInput } from '../extension/tools.ts';

test('exempt tools', () => {
  for (const name of ['read', 'grep', 'find', 'ls', 'tool_search', 'codemode']) {
    assert.equal(classifyTool(name, {}).kind, 'exempt');
  }
});

test('bash is shell with its command', () => {
  const d = classifyTool('bash', { command: 'ls' });
  assert.deepEqual(d, { kind: 'shell', name: 'bash', guardTool: 'Bash', command: 'ls' });
  assert.deepEqual(mappedInput(d), { command: 'ls' });
});

test('edit and write are edit tools with a path', () => {
  const edit = classifyTool('edit', { path: 'a.ts' });
  const write = classifyTool('write', { path: 'b.ts' });
  assert.deepEqual(edit, { kind: 'edit', name: 'edit', guardTool: 'Edit', path: 'a.ts' });
  assert.deepEqual(write, { kind: 'edit', name: 'write', guardTool: 'Write', path: 'b.ts' });
  assert.deepEqual(mappedInput(write), { file_path: 'b.ts' });
});

test('powershell, mcp and unknown', () => {
  assert.equal(classifyTool('powershell', { command: 'dir' }).kind, 'powershell');
  assert.equal(classifyTool('mcp__srv__tool', {}).kind, 'mcp');
  assert.equal(classifyTool('custom', {}).kind, 'unknown');
});

test('names are case-sensitive', () => {
  for (const name of ['Bash', 'Read', 'EDIT', 'Write', 'PowerShell']) {
    assert.equal(classifyTool(name, { command: 'ls', path: 'x' }).kind, 'unknown');
  }
});

test('missing or non-string fields are left unset', () => {
  const shell = classifyTool('bash', { command: 5 });
  assert.equal(shell.command, undefined);
  assert.equal(mappedInput(shell), undefined);
  const edit = classifyTool('edit', {});
  assert.equal(edit.path, undefined);
  assert.equal(mappedInput(edit), undefined);
  assert.equal(mappedInput(classifyTool('read', {})), undefined);
});
