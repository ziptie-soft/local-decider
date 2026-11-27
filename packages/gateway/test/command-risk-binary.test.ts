import { evaluateRules, type Answer, type Answers } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPolicyFile } from '../src/policies.ts';

const POLICIES = fileURLToPath(new URL('../../../policies/', import.meta.url));
const policy = loadPolicyFile(join(POLICIES, 'command-risk-binary.yaml'));

function risky(answer: 'true' | 'false', pTrue: number, confidence: number): Answers {
  const result: Answer = {
    type: 'noul',
    answer,
    probabilities: { true: pTrue, false: 1 - pTrue },
    confidence,
  };
  return { risky: result };
}

describe('command-risk-binary policy', () => {
  it('loads as a variant of command-risk with one noul question', () => {
    assert.equal(policy.id, 'command-risk-binary');
    assert.equal(policy.variantOf, 'command-risk');
    assert.deepEqual(Object.keys(policy.questions), ['risky']);
    assert.equal(policy.questions['risky']?.type, 'noul');
  });

  it('never denies', () => {
    assert.ok(policy.rules.every((rule) => rule.action !== 'deny'));
    assert.notEqual(policy.default, 'deny');
  });

  it('asks on a true answer at p 0.25', () => {
    assert.equal(evaluateRules(policy, risky('true', 0.25, 0.5)).action, 'ask');
  });

  it('logs a confident false answer', () => {
    assert.equal(evaluateRules(policy, risky('false', 0.05, 0.9)).action, 'log');
  });

  it('asks when there is no answer', () => {
    assert.equal(evaluateRules(policy, {}).action, 'ask');
  });
});
