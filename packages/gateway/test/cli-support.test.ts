import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { fetchPolicyList, parseInputJson, runFlmStep, UsageError } from '../src/cli-support.ts';
import { GATEWAY_VERSION } from '../src/version.ts';

describe('parseInputJson', () => {
  it('returns an object and rejects bad JSON and non-objects with UsageError', () => {
    assert.deepEqual(parseInputJson('{"a":1}'), { a: 1 });
    assert.throws(
      () => parseInputJson('{oops'),
      (e) => e instanceof UsageError && /not valid JSON/.test(e.message),
    );
    assert.throws(() => parseInputJson('[1]'), UsageError);
    assert.throws(() => parseInputJson('null'), UsageError);
  });
});

const answer = (status: number, body: unknown) => async () =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as never;

describe('fetchPolicyList', () => {
  it('returns the body of a 200 and requests /v1/policies', async () => {
    const paths: string[] = [];
    const result = await fetchPolicyList(async (path) => {
      paths.push(path);
      return answer(200, { policies: [] })();
    }, 'refused');
    assert.deepEqual(result, { policies: [] });
    assert.deepEqual(paths, ['/v1/policies']);
  });

  it('names a refused token, a bad status and an unreachable gateway', async () => {
    await assert.rejects(fetchPolicyList(answer(401, {}), 'refused: token'), /refused: token/);
    await assert.rejects(fetchPolicyList(answer(500, {}), 'r'), /answered 500 for \/v1\/policies/);
    await assert.rejects(
      fetchPolicyList(async () => Promise.reject(new Error('ECONNREFUSED')), 'r'),
      /unreachable.*ECONNREFUSED/,
    );
  });
});

describe('runFlmStep', () => {
  it('names the step and exit status of a failing flm', () => {
    const fail = (() => {
      throw Object.assign(new Error('Command failed'), { status: 3 });
    }) as never;
    assert.throws(
      () => runFlmStep('/bin/flm', ['validate'], fail),
      /flm validate exited with status 3 \(\/bin\/flm\)/,
    );
    const missing = (() => {
      throw new Error('spawn ENOENT');
    }) as never;
    assert.throws(
      () => runFlmStep('/bin/flm', ['pull', 'm'], missing),
      /flm pull failed to run: spawn ENOENT/,
    );
  });

  it('runs the step with inherited stdio', () => {
    const calls: unknown[][] = [];
    runFlmStep('/bin/flm', ['validate'], ((...a: unknown[]) => calls.push(a)) as never);
    assert.deepEqual(calls, [['/bin/flm', ['validate'], { stdio: 'inherit' }]]);
  });
});

describe('gateway version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    assert.equal(GATEWAY_VERSION, pkg.version);
  });
});
