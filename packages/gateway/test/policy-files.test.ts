import { PolicyError } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { defaultPolicyDir, loadPolicies, loadPolicyFile } from '../src/policies.ts';
import { testConfig } from './helpers.ts';

const POLICY = `
id: demo
version: 1
description: demo
state: { sections: [{ label: In, from: text }] }
questions:
  flag: { type: noul, instructions: Is it? }
rules:
  - when: { question: flag, answer: true, minConfidence: 0.9 }
    action: deny
default: ask
`;

const dirs: string[] = [];

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ld-policy-files-'));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadPolicyFile', () => {
  it('loads a policy whose id is the file name and coerces `answer: true`', () => {
    const dir = dirWith({ 'demo.yaml': POLICY });
    const policy = loadPolicyFile(join(dir, 'demo.yaml'));
    assert.equal(policy.id, 'demo');
    assert.equal(policy.rules[0]?.when.answer, 'true');
  });

  it('rejects an id that differs from the file name, naming the file', () => {
    const dir = dirWith({ 'other.yaml': POLICY });
    assert.throws(
      () => loadPolicyFile(join(dir, 'other.yaml')),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(
          error.message,
          /other\.yaml: policy id "demo" must equal the file name "other"/,
        );
        return true;
      },
    );
  });

  it('rejects duplicate threshold keys', () => {
    const dup = POLICY.replace(
      'default: ask',
      '  - when: { question: flag, answer: true, minConfidence: 0.5 }\n    action: ask\ndefault: ask',
    );
    const dir = dirWith({ 'demo.yaml': dup });
    assert.throws(() => loadPolicyFile(join(dir, 'demo.yaml')), /repeats the threshold key/);
  });

  it('loads every shipped default policy', () => {
    const root = defaultPolicyDir();
    const files = readdirSync(root).filter((name) => name.endsWith('.yaml'));
    assert.ok(files.length >= 4);
    for (const name of files) {
      assert.equal(loadPolicyFile(join(root, name)).id, name.replace(/\.yaml$/, ''));
    }
  });
});

describe('loadPolicies', () => {
  it('fails on a policy file named differently from its id', () => {
    const dir = dirWith({ 'renamed.yaml': POLICY });
    assert.throws(() => loadPolicies(testConfig(), [dir]), /must equal the file name "renamed"/);
  });

  it('fails when .yaml and .yml declare the same id, naming both files', () => {
    const dir = dirWith({ 'demo.yaml': POLICY, 'demo.yml': POLICY });
    assert.throws(
      () => loadPolicies(testConfig(), [dir]),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /demo\.yml: policy id "demo" is also defined by .*demo\.yaml/);
        return true;
      },
    );
  });

  it('lets a later directory override an earlier one with the same id', () => {
    const early = dirWith({ 'demo.yaml': POLICY });
    const late = dirWith({ 'demo.yaml': POLICY.replace('description: demo', 'description: mine') });
    const loaded = loadPolicies(testConfig(), [early, late]);
    assert.equal(loaded.get('demo')?.policy.description, 'mine');
  });
});
