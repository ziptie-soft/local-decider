import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluateRules, parsePolicy, withThresholds, type Answers } from '../src/index.ts';

const POLICY = parsePolicy(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'policies', 'command-risk.yaml'),
    'utf8',
  ),
  'command-risk.yaml',
);

function risk(answer: string, probabilities: Record<string, number>, confidence: number): Answers {
  return { risk: { type: 'choice', answer, probabilities, confidence } };
}

const action = (answers: Answers, policy = POLICY): string => evaluateRules(policy, answers).action;

describe('command-risk policy', () => {
  it('asks on a low-confidence safe', () => {
    // `rm -rf build` as the 2B model rated it.
    assert.equal(action(risk('safe', { safe: 0.55, caution: 0.3, dangerous: 0.15 }, 0.27)), 'ask');
    assert.equal(action(risk('safe', { safe: 0.62, caution: 0.25, dangerous: 0.13 }, 0.4)), 'ask');
  });

  it('logs a confident safe', () => {
    assert.equal(action(risk('safe', { safe: 0.84, caution: 0.09, dangerous: 0.07 }, 0.77)), 'log');
    assert.equal(action(risk('safe', { safe: 0.77, caution: 0.15, dangerous: 0.08 }, 0.66)), 'log');
  });

  it('denies a confident dangerous and asks on an unsure one', () => {
    assert.equal(action(risk('dangerous', { dangerous: 0.85, safe: 0.1 }, 0.8)), 'deny');
    assert.equal(action(risk('dangerous', { dangerous: 0.6, safe: 0.3 }, 0.5)), 'ask');
  });

  it('asks on caution whether or not it reaches p 0.5', () => {
    assert.equal(action(risk('caution', { caution: 0.55, safe: 0.35 }, 0.32)), 'ask');
    assert.equal(
      action(risk('caution', { caution: 0.45, safe: 0.4, dangerous: 0.15 }, 0.18)),
      'ask',
    );
  });

  it('asks when the risk answer is missing', () => {
    assert.equal(action({}), 'ask');
  });

  it('moves the safe floor with a risk.safe threshold override', () => {
    const answers = risk('safe', { safe: 0.7, caution: 0.2, dangerous: 0.1 }, 0.45);
    assert.equal(action(answers), 'ask');
    assert.equal(action(answers, withThresholds(POLICY, { 'risk.safe': 0.3 })), 'log');
    const confident = risk('safe', { safe: 0.8, caution: 0.15, dangerous: 0.05 }, 0.65);
    assert.equal(action(confident, withThresholds(POLICY, { 'risk.safe': 0.7 })), 'ask');
  });
});
