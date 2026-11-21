import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { installProcessGuards } from '../src/process-guards.ts';

function setup(): {
  proc: EventEmitter;
  lines: string[];
  exits: number[];
  clock: { now: number };
} {
  const proc = new EventEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  const clock = { now: 0 };
  installProcessGuards({
    proc,
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    now: () => clock.now,
  });
  return { proc, lines, exits, clock };
}

describe('installProcessGuards', () => {
  it('logs a redacted one-line rejection and does not exit', () => {
    const { proc, lines, exits } = setup();
    const error = new Error('boom with Authorization: Bearer abcdefghijklmnop123\nsecond line');
    proc.emit('unhandledRejection', error);
    assert.equal(lines.length, 1);
    const line = lines[0] ?? '';
    assert.match(line, /^local-decider: unhandled rejection: Error: boom with /);
    assert.ok(!line.includes('abcdefghijklmnop123'));
    assert.ok(!line.includes('second line'));
    assert.ok(!line.includes('\n'));
    assert.deepEqual(exits, []);
  });

  it('cuts a long message to 300 characters', () => {
    const { proc, lines } = setup();
    proc.emit('unhandledRejection', new Error('x'.repeat(2000)));
    assert.ok(!(lines[0] ?? '').includes('x'.repeat(301)));
  });

  it('rate-limits rejections and reports the suppressed count', () => {
    const { proc, lines, clock } = setup();
    proc.emit('unhandledRejection', new Error('a'));
    proc.emit('unhandledRejection', new Error('b'));
    proc.emit('unhandledRejection', new Error('c'));
    assert.equal(lines.length, 1);
    clock.now = 10_000;
    proc.emit('unhandledRejection', new Error('d'));
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? '', /\(2 more suppressed\)$/);
  });

  it('handles a non-error rejection', () => {
    const { proc, lines } = setup();
    proc.emit('unhandledRejection', 'plain string');
    assert.match(lines[0] ?? '', /non-error: plain string/);
  });

  it('logs an uncaught exception and exits with 1', () => {
    const { proc, lines, exits } = setup();
    proc.emit('uncaughtException', new Error('fatal'));
    assert.match(lines[0] ?? '', /^local-decider: uncaught exception: Error: fatal/);
    assert.deepEqual(exits, [1]);
  });
});
