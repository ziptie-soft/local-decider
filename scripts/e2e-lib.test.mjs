import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCaptured } from './e2e-lib.mjs';

// A child that reads one line, prints it, then keeps running until stdin closes, like a headless
// Claude Code that finishes async hooks only while its stdin is open.
const CHILD = `
  process.stdin.once('data', (d) => process.stdout.write('result:' + d));
  process.stdin.on('end', () => process.stdout.write('closed\\n'));
  process.stdin.resume();
`;

describe('runCaptured with input', () => {
  it('holds stdin open until inputDone holds, then closes it after the grace', async () => {
    const run = await runCaptured({
      bin: process.execPath,
      args: ['-e', CHILD],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 10_000,
      input: 'hello\n',
      inputDone: (stdout) => stdout.includes('result:'),
      graceMs: 200,
    });
    assert.equal(run.code, 0);
    assert.match(run.stdout, /result:hello\nclosed\n/);
  });
});
