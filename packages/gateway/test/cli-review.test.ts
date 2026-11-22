import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainCommand } from '../src/cli-review.ts';
import { UsageError } from '../src/cli-support.ts';
import { openLogStore } from '../src/sqlite-log.ts';
import { tempPaths, testConfig } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

const config = testConfig();
const ANSWERS = {
  verdict: {
    type: 'choice' as const,
    answer: 'allow',
    probabilities: { allow: 0.9, ask: 0.1 },
    confidence: 0.8,
  },
};

function seeded(): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  const log = openLogStore(paths);
  log.append(makeShadowRecord('11111111-aaaa', { callId: 'toolu_1', answers: ANSWERS, rule: 1 }));
  log.append(makeShadowRecord('22222222-bbbb', { callId: 'toolu_1', policy: 'command-risk' }));
  log.append({
    kind: 'outcome',
    ts: '2026-11-10T00:00:05.000Z',
    decisionId: '11111111-aaaa',
    outcome: 'unsafe',
    source: 'user',
    verified: true,
  });
  log.close();
  return paths;
}

const run = (paths: ReturnType<typeof tempPaths>, ...args: string[]): string =>
  explainCommand({ paths, config, args });

describe('explain command', () => {
  it('explains one decision as text and JSON', () => {
    const paths = seeded();
    assert.match(run(paths, '11111111-aaaa'), /^decision 11111111-aaaa {2}permission/);
    const json = JSON.parse(run(paths, '11111111-aaaa', '--json')) as Record<string, unknown>;
    assert.equal(json['decisionId'], '11111111-aaaa');
    assert.equal(json['effectiveOutcome'], 'unsafe');
  });

  it('explains every decision of a call id, as a list in JSON', () => {
    const paths = seeded();
    const text = run(paths, 'toolu_1');
    assert.match(text, /decision 11111111-aaaa/);
    assert.match(text, /decision 22222222-bbbb/);
    const json = JSON.parse(run(paths, 'toolu_1', '--json')) as unknown[];
    assert.equal(json.length, 2);
  });

  it('fails with exit 1 semantics (a plain error) on an unknown id or a fresh install', () => {
    const missing = /unknown decision: pruned after logs\.retainDays or never recorded/;
    assert.throws(
      () => run(seeded(), 'nope'),
      (error: unknown) => {
        return (
          error instanceof Error && !(error instanceof UsageError) && missing.test(error.message)
        );
      },
    );
    assert.throws(() => run(tempPaths(), 'nope'), missing);
  });

  it('rejects bad arguments as usage errors', () => {
    const paths = seeded();
    for (const args of [[], ['a', 'b'], ['bad id!'], ['11111111-aaaa', '--bogus'], ['a/b']]) {
      assert.throws(() => run(paths, ...args), UsageError, JSON.stringify(args));
    }
  });
});
