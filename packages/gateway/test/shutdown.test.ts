import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installShutdown } from '../src/shutdown.ts';

interface Harness {
  readonly handlers: Map<string, () => void>;
  readonly lines: string[];
  readonly codes: number[];
  flushed(): number;
}

function harness(close: () => Promise<void>, hardMs = 50): Harness {
  const handlers = new Map<string, () => void>();
  const lines: string[] = [];
  const codes: number[] = [];
  let flushed = 0;
  installShutdown({
    proc: { once: (event, listener) => handlers.set(event, listener) },
    gateway: { close, flushLog: () => (flushed += 1) },
    log: (line) => lines.push(line),
    exit: (code) => codes.push(code),
    hardMs,
  });
  return { handlers, lines, codes, flushed: () => flushed };
}

const tick = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

describe('installShutdown', () => {
  it('exits 0 after a clean close and flushes the log on exit', async () => {
    const h = harness(() => Promise.resolve());
    h.handlers.get('SIGTERM')?.();
    await tick(10);
    assert.deepEqual(h.codes, [0]);
    h.handlers.get('exit')?.();
    assert.equal(h.flushed(), 1);
  });

  it('logs a failing close redacted and still exits, with code 1', async () => {
    const secret = `sk-${'b'.repeat(40)}`;
    const h = harness(() => Promise.reject(new Error(`close failed ${secret}`)));
    h.handlers.get('SIGINT')?.();
    await tick(10);
    assert.deepEqual(h.codes, [1]);
    assert.equal(h.lines.length, 1);
    assert.ok(!h.lines[0]?.includes(secret));
    assert.match(h.lines[0] ?? '', /shutdown failed/);
  });

  it('exits from the hard timer when close hangs, once per signal burst', async () => {
    const h = harness(() => new Promise<void>(() => {}), 30);
    h.handlers.get('SIGTERM')?.();
    h.handlers.get('SIGTERM')?.();
    await tick(80);
    assert.deepEqual(h.codes, [1]);
    assert.match(h.lines.join('\n'), /exceeded 30 ms/);
  });
});
