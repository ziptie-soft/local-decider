import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  engineAnsweredResult,
  engineAnswers,
  modPreconditionSkip,
  outcomesPreconditionSkip,
  runCaptured,
} from './e2e-lib.mjs';

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

const ANSWER = { risk: { answer: 'log', confidence: 0.9 } };
const timedOut = {
  policy: 'command-risk',
  action: 'ask',
  error: 'decision timed out',
  answers: {},
};
const answered = { policy: 'command-risk', action: 'log', answers: ANSWER, permissionMode: 'auto' };

describe('engineAnswers', () => {
  it('counts answered decisions and names the dominant error', () => {
    const decisions = [timedOut, timedOut, { ...timedOut, error: 'engine crashed' }, answered];
    assert.deepEqual(engineAnswers(decisions), {
      answered: 1,
      total: 4,
      dominantError: 'decision timed out',
    });
  });

  it('fails with the dominant error when every decision failed', () => {
    const result = engineAnsweredResult([timedOut, timedOut]);
    assert.equal(result.ok, false);
    assert.equal(result.detail, '0 of 2 decisions, need >= 1 (decision timed out)');
  });

  it('passes when at least one decision has an answer', () => {
    const result = engineAnsweredResult([timedOut, answered]);
    assert.equal(result.ok, true);
    assert.equal(result.detail, '1 of 2 decisions, need >= 1');
  });

  it('fails with no decisions at all', () => {
    assert.deepEqual(engineAnsweredResult([]), {
      ok: false,
      detail: '0 of 0 decisions, need >= 1',
    });
  });
});

describe('modPreconditionSkip', () => {
  it('skips unless a command-risk decision answered log in auto mode', () => {
    assert.match(modPreconditionSkip([timedOut]), /answered `log`/);
    assert.match(modPreconditionSkip([{ ...answered, permissionMode: 'default' }]), /auto mode/);
    assert.match(modPreconditionSkip([{ ...answered, action: 'ask' }]), /auto mode/);
    assert.match(modPreconditionSkip([{ ...answered, error: 'x' }]), /auto mode/);
  });

  it('runs the check when the precondition occurred', () => {
    assert.equal(modPreconditionSkip([timedOut, answered]), undefined);
  });
});

describe('outcomesPreconditionSkip', () => {
  const asked = { policy: 'permission', action: 'ask', enforced: false, answers: {} };
  const enforcedAllow = { policy: 'permission', action: 'allow', enforced: true, answers: ANSWER };
  const allow = [{ behavior: 'allow' }];

  it('skips when the plugin allowed every prompt itself', () => {
    assert.match(outcomesPreconditionSkip([enforcedAllow], allow), /enforced allow/);
    assert.match(outcomesPreconditionSkip([], allow), /enforced allow/);
  });

  it('skips when the approver allowed nothing', () => {
    assert.match(outcomesPreconditionSkip([asked], [{ behavior: 'deny' }]), /allowed no prompt/);
  });

  it('runs the check when a prompt reached the user and was allowed', () => {
    assert.equal(outcomesPreconditionSkip([enforcedAllow, asked], allow), undefined);
  });
});
