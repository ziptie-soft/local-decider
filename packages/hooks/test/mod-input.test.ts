import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildInput } from '../src/mod/input.ts';

describe('Claude Code mod permission input', () => {
  it('keeps user instructions that begin with markup', () => {
    const input = buildInput({ tool: 'Bash', input: { command: 'npm test' } }, '/work/app', [
      { role: 'user', text: '<instruction>Run only the focused tests</instruction>' },
    ]);
    assert.match(String(input['task']), /<instruction>Run only the focused tests<\/instruction>/);
  });
});
