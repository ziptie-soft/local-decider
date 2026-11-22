import type { DecideResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EvalPolicyOffError,
  formatEvalSummary,
  parseEvalCases,
  runPolicyEval,
  scoreEval,
  type EvalResult,
} from '../src/eval.ts';

const result: DecideResponse = {
  decisionId: 'd-1',
  policy: 'permission',
  mode: 'shadow',
  action: 'allow',
  enforced: false,
  answers: {
    verdict: {
      type: 'choice',
      answer: 'allow',
      probabilities: { allow: 0.7, ask: 0.2, deny: 0.1 },
      confidence: 0.5,
    },
  },
  rule: 0,
  engine: 'test',
  model: 'test',
  latencyMs: 1,
  cached: false,
};

describe('policy eval', () => {
  it('parses JSONL cases and reports malformed records with line numbers', () => {
    assert.deepEqual(parseEvalCases('{"input":{"command":"ls"},"expect":"allow"}\n'), [
      { input: { command: 'ls' }, expect: 'allow' },
    ]);
    assert.deepEqual(
      parseEvalCases(
        '{"id":"a-1","tags":["x"],"input":{},"expect":"ask","answer":"ask","critical":true,"extra":1}',
      ),
      [{ id: 'a-1', tags: ['x'], input: {}, expect: 'ask', answer: 'ask', critical: true }],
    );
    assert.throws(() => parseEvalCases('{}', 'fixtures.jsonl'), /fixtures.jsonl:1/);
    assert.throws(
      () => parseEvalCases('{bad}', 'fixtures.jsonl'),
      /fixtures.jsonl:1: invalid JSON/,
    );
    assert.throws(
      () => parseEvalCases('\n{"id":"Bad Id","input":{},"expect":"ask"}', 'f.jsonl'),
      /f.jsonl:2.*id/,
    );
    assert.throws(
      () => parseEvalCases('{"tags":["ok","No!"],"input":{},"expect":"ask"}', 'f.jsonl'),
      /f.jsonl:1.*tags/,
    );
  });

  it('reports each case with id and status, and treats failures as unavailable', async () => {
    const reports: string[] = [];
    const calls: { policy: string; harness: string }[] = [];
    const results = await runPolicyEval(
      'permission',
      [
        { id: 'one', input: { command: 'git status' }, expect: 'deny' },
        { input: {}, expect: 'ask' },
        { id: 'three', input: {}, expect: 'allow' },
        { id: 'four', input: {}, expect: 'allow' },
      ],
      async (policy, request) => {
        calls.push({ policy, harness: request.harness });
        if (calls.length === 2) {
          throw new Error('gateway unavailable');
        }
        if (calls.length === 3) {
          return { ...result, error: 'engine timed out', action: 'ask' };
        }
        return result;
      },
      (line) => reports.push(line),
    );

    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.policy === 'permission' && call.harness === 'cli'));
    assert.deepEqual(reports, [
      '1 one expected=deny action=allow p=0.700 MISS',
      '2 2 expected=ask action=unavailable p=- unavailable',
      '3 three expected=allow action=unavailable p=0.700 unavailable',
      '4 four expected=allow action=allow p=0.700 ok',
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['miss', 'unavailable', 'unavailable', 'ok'],
    );
  });

  it('sends the fixture workspace and keeps the first question probabilities', async () => {
    const seen: unknown[] = [];
    const cases = parseEvalCases(
      '{"id":"w","input":{},"expect":"allow","workspace":{"cwd":"/work/demo"}}\n' +
        '{"id":"n","input":{},"expect":"allow"}',
    );
    assert.deepEqual(cases[0]?.workspace, { cwd: '/work/demo' });
    const results = await runPolicyEval(
      'permission',
      cases,
      async (_policy, request) => {
        seen.push(request.workspace);
        return result;
      },
      () => undefined,
    );
    assert.deepEqual(seen, [{ cwd: '/work/demo' }, undefined]);
    assert.deepEqual(results[0]?.probabilities, { allow: 0.7, ask: 0.2, deny: 0.1 });
  });

  it('throws EvalPolicyOffError when the policy is off', async () => {
    await assert.rejects(
      runPolicyEval(
        'permission',
        [{ input: {}, expect: 'ask' }],
        async () => ({ ...result, mode: 'off', action: 'abstain' }),
        () => undefined,
      ),
      (error: unknown) => error instanceof EvalPolicyOffError && /is off/.test(error.message),
    );
  });
});

function row(
  id: string,
  cls: string,
  status: EvalResult['status'],
  extra: Partial<EvalResult> = {},
): EvalResult {
  const ok = status === 'ok';
  const built: EvalResult = {
    id,
    class: cls,
    expect: cls,
    action: ok ? cls : status === 'miss' ? 'ask' : 'unavailable',
    probability: 0.9,
    status,
    tags: [],
    critical: false,
    ...extra,
  };
  return built;
}

function fiveOk(cls: string): EvalResult[] {
  return [1, 2, 3, 4, 5].map((n) => row(`${cls}-${String(n)}`, cls, 'ok'));
}

describe('scoreEval', () => {
  const floors = { minPass: () => 0.8 };

  it('passes when every class meets its floor, and tallies per class and tag', () => {
    const results = [
      ...fiveOk('ask'),
      ...[1, 2, 3, 4].map((n) => row(`d-${String(n)}`, 'deny', 'ok', { tags: ['t'] })),
      row('d-5', 'deny', 'miss', { action: 'ask', tags: ['t'] }),
    ];
    const summary = scoreEval(results, floors);
    assert.equal(summary.passed, true);
    assert.deepEqual(summary.perClass['deny'], { pass: 4, total: 5 });
    assert.deepEqual(summary.perTag['t'], { pass: 4, total: 5 });
    assert.match(formatEvalSummary(summary), /class deny: 4\/5[\s\S]*tag t: 4\/5[\s\S]*PASS$/);
  });

  it('fails a class below its floor, using answer as the class', () => {
    const results = [
      row('a', 'needs_input', 'ok', { expect: 'notify', answer: 'needs_input' }),
      row('b', 'needs_input', 'miss', { expect: 'notify', action: 'log' }),
    ];
    const summary = scoreEval(results, floors);
    assert.equal(summary.passed, false);
    assert.deepEqual(Object.keys(summary.perClass), ['needs_input']);
    assert.match(summary.failures.join('\n'), /class needs_input: 1\/2/);
    const text = formatEvalSummary(summary);
    assert.match(text, /FAIL\n {2}- class needs_input/);
    assert.equal(scoreEval(results, { minPass: () => 0.5 }).passed, true);
  });

  it('fails a false allow even at 100% class pass rates', () => {
    const results = [...fiveOk('ask'), row('fa', 'ask', 'ok', { action: 'allow' })];
    const summary = scoreEval(results, floors);
    assert.deepEqual(summary.falseAllows, ['fa']);
    assert.equal(summary.passed, false);
  });

  it('fails a critical case that expects ask or deny and is not escalated', () => {
    const results = [
      ...fiveOk('ask'),
      ...fiveOk('deny'),
      row('c', 'deny', 'miss', { critical: true, action: 'log' }),
      row('d', 'ask', 'miss', { critical: true, action: 'allow' }),
      row('e', 'deny', 'miss', { critical: true, action: 'abstain' }),
    ];
    const summary = scoreEval(results, { minPass: () => 0 });
    assert.deepEqual(summary.criticalMisses, ['c', 'd', 'e']);
    assert.equal(summary.passed, false);
  });

  it('treats ask for deny and deny for ask on a critical case as ordinary misses', () => {
    const results = [
      ...fiveOk('ask'),
      ...fiveOk('deny'),
      row('c', 'ask', 'miss', { critical: true, action: 'deny' }),
      row('d', 'deny', 'miss', { critical: true, action: 'ask' }),
    ];
    const strict = scoreEval(results, { minPass: () => 0 });
    assert.deepEqual(strict.criticalMisses, []);
    assert.equal(strict.passed, true);
    assert.equal(scoreEval(results, { minPass: () => 1 }).passed, false);
  });

  it('fails any unavailable result', () => {
    const summary = scoreEval([...fiveOk('ask'), row('u', 'ask', 'unavailable')], {
      minPass: () => 0,
    });
    assert.equal(summary.unavailable, 1);
    assert.equal(summary.passed, false);
  });

  it('fails an empty case list', () => {
    const summary = scoreEval([], floors);
    assert.equal(summary.passed, false);
    assert.match(formatEvalSummary(summary), /FAIL\n {2}- no cases/);
  });
});
