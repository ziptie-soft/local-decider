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

const MIB3 = 3 * 1024 * 1024;

describe('Claude Code mod input caps', () => {
  for (const [name, big] of [
    ['string', 'x'.repeat(MIB3)],
    ['object', { command: 'x'.repeat(MIB3) }],
  ] as const) {
    it(`caps a 3 MiB ${name} tool input`, () => {
      const input = buildInput({ tool: 'Bash', input: big }, '/work/app', []);
      assert.ok(JSON.stringify(input).length < 256 * 1024);
      assert.equal('subject' in input && String(input['subject']).length > 4096, false);
    });
  }
});
