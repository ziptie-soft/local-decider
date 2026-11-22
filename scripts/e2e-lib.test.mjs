import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  duplicateDecisions,
  engineAnsweredResult,
  engineAnswers,
  modPreconditionSkip,
  noDuplicatesResult,
  outcomesPreconditionSkip,
  runCaptured,
  withoutHostPolicies,
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

const row = (ts, extra = {}) => ({
  policy: 'command-risk',
  inputHash: 'abc',
  cached: false,
  ts: `2026-11-22T10:00:${ts}Z`,
  ...extra,
});

describe('duplicateDecisions', () => {
  it('flags the same policy and input recorded twice within a second', () => {
    const result = noDuplicatesResult([
      row('00.100'),
      row('00.350'),
      row('09.000', { inputHash: 'x' }),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.detail, /command-risk x2 .*duplicate plugin or hook install/);
  });

  it('accepts a legitimate repeat seconds apart', () => {
    assert.deepEqual(duplicateDecisions([row('00.000'), row('03.000')]), []);
  });

  it('ignores cached rows, other inputs, other policies and distinct tool calls', () => {
    assert.deepEqual(duplicateDecisions([row('00.000'), row('00.200', { cached: true })]), []);
    assert.deepEqual(duplicateDecisions([row('00.000'), row('00.200', { inputHash: 'z' })]), []);
    assert.deepEqual(
      duplicateDecisions([row('00.000'), row('00.200', { policy: 'permission' })]),
      [],
    );
    assert.deepEqual(
      duplicateDecisions([row('00.000', { callId: 'a' }), row('00.200', { callId: 'b' })]),
      [],
    );
  });

  it('flags two records of one tool call', () => {
    const found = duplicateDecisions([
      row('00.000', { callId: 'a' }),
      row('00.200', { callId: 'a' }),
    ]);
    assert.deepEqual(found, [{ policy: 'command-risk', count: 2 }]);
  });

  it('passes with no decisions', () => {
    assert.equal(noDuplicatesResult([]).ok, true);
  });
});

describe('withoutHostPolicies', () => {
  it('clears the Paseo host marker so the plugin hooks run every policy', () => {
    const env = withoutHostPolicies({
      PATH: '/bin',
      LOCAL_DECIDER_HOST_POLICIES: 'turn-outcome,permission,routing',
    });
    assert.equal(env.LOCAL_DECIDER_HOST_POLICIES, '');
    assert.equal(env.PATH, '/bin');
  });
});
