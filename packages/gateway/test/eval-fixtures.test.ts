import {
  deterministicBlock,
  redactDeep,
  trimTrailingSlashes,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseEvalCases, type PolicyEvalCase } from '../src/eval.ts';
import { loadPolicyFile } from '../src/policies.ts';

const POLICIES = fileURLToPath(new URL('../../../policies/', import.meta.url));
const FIXTURES = join(POLICIES, 'fixtures');
/** The blind holdout set for the next tuning round, in the same schema. */
const HOLDOUT = join(FIXTURES, 'holdout');
const KNOWN_KEYS = new Set(['id', 'tags', 'input', 'expect', 'answer', 'critical', 'workspace']);
/** Tags whose cases must never be waved through. */
const NEVER_PASS_TAGS = [
  'injection',
  'forged-section',
  'padding',
  'exfil',
  'remote-code',
  'destructive',
  'privilege',
];
/** The action a policy uses for "no friction". */
const PASS_ACTION: Readonly<Record<string, string>> = {
  'permission': 'allow',
  'command-risk': 'log',
};
const MIN_PER_CLASS = 5;
/** Permission and command-risk fixtures run from this project, as `demo (/work/demo)`. */
const FIXTURE_CWD = '/work/demo';

/** `name (cwd)`, as the hooks' `projectLabel` builds it. */
function projectLabel(cwd: string): string {
  const name = trimTrailingSlashes(cwd).split('/').at(-1) ?? '';
  return `${name === '' ? cwd : name} (${cwd})`;
}

function callOf(testCase: PolicyEvalCase): { tool: string; request: unknown } {
  const input = testCase.input;
  const request = input['request'] ?? { command: input['command'] };
  return { tool: typeof input['tool'] === 'string' ? input['tool'] : 'Bash', request };
}

interface Fixture {
  readonly policyId: string;
  readonly file: string;
  readonly cases: readonly PolicyEvalCase[];
  readonly raw: readonly Record<string, unknown>[];
}

function readFixtures(dir: string): Fixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .toSorted()
    .map((name) => {
      const file = join(dir, name);
      const source = readFileSync(file, 'utf8');
      const raw = source
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      return {
        policyId: basename(name, '.jsonl'),
        file: name,
        cases: parseEvalCases(source, name),
        raw,
      };
    });
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

function classOf(testCase: PolicyEvalCase): string {
  return testCase.answer ?? testCase.expect;
}

const tuningFixtures = readFixtures(FIXTURES);
const holdoutFixtures = readFixtures(HOLDOUT);

describe('policy fixtures', () => {
  runFixtureSuite(tuningFixtures);

  it('has a fixture file per shipped policy', () => {
    assert.deepEqual(
      tuningFixtures.map((fixture) => fixture.policyId).toSorted(),
      [
        'command-risk',
        'permission',
        'routing',
        'routing-budget',
        'routing-task-kind',
        'turn-outcome',
      ].toSorted(),
    );
  });
});

describe('holdout fixtures', () => {
  runFixtureSuite(holdoutFixtures);

  it('has ids unique per policy across the tuning set and the holdout', () => {
    for (const fixture of holdoutFixtures) {
      const tuning = tuningFixtures.find((other) => other.policyId === fixture.policyId);
      const ids = [...(tuning?.cases ?? []), ...fixture.cases].map((testCase) => testCase.id);
      assert.equal(new Set(ids).size, ids.length, `${fixture.file}: ids must not repeat`);
    }
  });

  it('only holds files for shipped policies and covers the tuned ones', () => {
    const shipped = new Set(tuningFixtures.map((fixture) => fixture.policyId));
    for (const fixture of holdoutFixtures) {
      assert.ok(shipped.has(fixture.policyId), `${fixture.file} has no shipped policy`);
    }
    assert.deepEqual(holdoutFixtures.map((fixture) => fixture.policyId).toSorted(), [
      'command-risk',
      'permission',
      'routing',
      'routing-budget',
      'turn-outcome',
    ]);
  });
});

function runFixtureSuite(fixtures: readonly Fixture[]): void {
  for (const fixture of fixtures) {
    describe(fixture.file, () => {
      const policy = loadPolicyFile(join(POLICIES, `${fixture.policyId}.yaml`));

      it('uses only known keys, unique ids and at least one tag per case', () => {
        for (const record of fixture.raw) {
          const unknown = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
          assert.deepEqual(unknown, [], `unknown keys in ${String(record['id'])}`);
        }
        const ids = fixture.cases.map((testCase) => testCase.id);
        assert.ok(
          ids.every((id) => id !== undefined),
          'every case needs an id',
        );
        assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
        for (const testCase of fixture.cases) {
          assert.ok((testCase.tags?.length ?? 0) > 0, `${String(testCase.id)} needs a tag`);
        }
      });

      it('expects an action the policy can produce and a real answer option', () => {
        const actions = new Set([...policy.rules.map((rule) => rule.action), policy.default]);
        const options = Object.values(policy.questions).flatMap((question) =>
          question.type === 'choice' ? Object.keys(question.criteria) : [],
        );
        for (const testCase of fixture.cases) {
          assert.ok(
            actions.has(testCase.expect as never),
            `${String(testCase.id)}: ${testCase.expect}`,
          );
          if (testCase.answer !== undefined) {
            assert.ok(
              options.includes(testCase.answer),
              `${String(testCase.id)}: ${testCase.answer}`,
            );
          }
        }
      });

      it(`has at least ${String(MIN_PER_CLASS)} cases per class`, () => {
        const counts = new Map<string, number>();
        for (const testCase of fixture.cases) {
          counts.set(classOf(testCase), (counts.get(classOf(testCase)) ?? 0) + 1);
        }
        for (const [cls, count] of counts) {
          assert.ok(count >= MIN_PER_CLASS, `class ${cls} has ${String(count)} cases`);
        }
      });

      it('keeps dangerous tags from being waved through and known-fp cases passing', () => {
        const pass = PASS_ACTION[fixture.policyId];
        if (pass === undefined) {
          return;
        }
        for (const testCase of fixture.cases) {
          const tags = testCase.tags ?? [];
          if (tags.some((tag) => NEVER_PASS_TAGS.includes(tag))) {
            assert.notEqual(
              testCase.expect,
              pass,
              `${String(testCase.id)} must not expect ${pass}`,
            );
          }
          if (tags.includes('known-fp')) {
            assert.equal(testCase.expect, pass, `${String(testCase.id)} is a known-fp case`);
          }
        }
      });

      it(
        'sets the workspace and project label, and tags guard-blocked cases exactly',
        { skip: PASS_ACTION[fixture.policyId] === undefined },
        () => {
          for (const testCase of fixture.cases) {
            const id = String(testCase.id);
            assert.equal(testCase.workspace?.cwd, FIXTURE_CWD, `${id} needs workspace.cwd`);
            assert.equal(testCase.input['project'], projectLabel(FIXTURE_CWD), `${id} project`);
            const { tool, request } = callOf(testCase);
            const blocked = deterministicBlock(tool, request, FIXTURE_CWD) !== null;
            assert.equal(
              (testCase.tags ?? []).includes('guard-blocked'),
              blocked,
              `${id}: guard-blocked tag must match deterministicBlock`,
            );
          }
        },
      );

      it('is synthetic and unchanged by redaction', () => {
        for (const testCase of fixture.cases) {
          const id = String(testCase.id);
          if (!(testCase.tags ?? []).includes('redaction')) {
            assert.deepEqual(
              redactDeep(testCase.input),
              testCase.input,
              `${id} is changed by redaction`,
            );
          }
          assertSynthetic(id, strings(testCase.input));
        }
      });
    });
  }
}

const SAFE_HOSTS = /(\.invalid|\.test|\.example)$|^example\.com$/;
const TEST_NET = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./;
const SAFE_PATH = /^\/(work|home\/user|tmp)(\/|$)|^\/bin\/(ba)?sh$/;

function assertSynthetic(id: string, texts: readonly string[]): void {
  for (const text of texts) {
    for (const [, host] of text.matchAll(/https?:\/\/([^\s/:'"]+)/g)) {
      assert.match(host ?? '', SAFE_HOSTS, `${id}: host ${String(host)}`);
    }
    for (const [ip] of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
      assert.ok(ip === '127.0.0.1' || TEST_NET.test(ip), `${id}: ip ${ip}`);
    }
    for (const [path] of text.matchAll(/(?<![\w.:/~-])\/[\w.-]+(?:\/[\w.-]+)*/g)) {
      assert.match(path, SAFE_PATH, `${id}: path ${path}`);
    }
  }
}
