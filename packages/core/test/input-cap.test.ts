import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { capInput, INPUT_CAPS, TRUNCATION_MARKER_RE } from '../src/index.ts';

describe('capInput', () => {
  it('leaves values within their cap alone', () => {
    const input = { project: 'p', command: 'ls', n: 3 };
    assert.deepEqual(capInput(input), input);
  });

  it('keeps both ends of a long string with the marker', () => {
    const text = `START${'x'.repeat(50_000)}END`;
    const out = capInput({ command: text })['command'] as string;
    assert.ok(out.length <= (INPUT_CAPS['command'] ?? 0));
    assert.ok(out.startsWith('START'));
    assert.ok(out.endsWith('END'));
    assert.match(out, TRUNCATION_MARKER_RE);
  });

  it('keeps the tail of history', () => {
    const out = capInput({ history: `OLD${'x'.repeat(50_000)}NEW` })['history'] as string;
    assert.ok(out.length <= (INPUT_CAPS['history'] ?? 0));
    assert.ok(out.endsWith('NEW'));
    assert.ok(!out.startsWith('OLD'));
  });

  it('serialises an object canonically before cutting', () => {
    const out = capInput({ request: { b: 'y'.repeat(50_000), a: 1 } })['request'] as string;
    assert.ok(out.startsWith('{"a":1,"b":"y'));
    assert.ok(out.length <= (INPUT_CAPS['request'] ?? 0));
  });

  it('caps unknown keys at 6000', () => {
    assert.equal((capInput({ other: 'z'.repeat(9000) })['other'] as string).length, 6000);
  });

  it('drops an over-cap subject and keeps one within it', () => {
    assert.equal('subject' in capInput({ subject: 's'.repeat(5000), tool: 'Bash' }), false);
    assert.equal(capInput({ subject: 'shell: ls' })['subject'], 'shell: ls');
  });
});
