import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactDeep, redactionLabelCounts, rulesHash } from '../src/index.ts';
import { parsePolicy, withThresholds } from '../src/index.ts';

const GH = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

describe('redactionLabelCounts', () => {
  it('counts labels the redaction added, in strings and keys', () => {
    const input = {
      tool: 'Bash',
      request: { command: `curl -H "Authorization: Bearer abcdefghijklmnop123" ${GH}` },
      password: 'hunter2',
      [`key-${GH}`]: 'x',
    };
    const out = redactDeep(input);
    const counts = redactionLabelCounts(input, out);
    assert.equal(counts['bearer'], 1);
    assert.equal(counts['secret-field'], 1);
    assert.equal(counts['github-token'], 2);
  });

  it('does not count labels already in the input', () => {
    const input = { text: 'was [REDACTED:bearer] before' };
    assert.deepEqual(redactionLabelCounts(input, redactDeep(input)), {});
  });

  it('is empty when nothing was redacted and survives cycles in the input', () => {
    const input: Record<string, unknown> = { a: 'plain' };
    input['self'] = input;
    const out = redactDeep(input);
    assert.deepEqual(redactionLabelCounts({ a: 'plain' }, { a: 'plain' }), {});
    assert.equal(redactionLabelCounts(input, out)['cycle'], 1);
  });

  it('leaves redactDeep output byte-identical to the recorded form', () => {
    const input = {
      command: `echo Bearer abcdefghijklmnop123 ${GH}`,
      env: { API_TOKEN: 'x' },
      list: ['--password', 'hunter2'],
    };
    const before = JSON.stringify(input);
    const first = JSON.stringify(redactDeep(input));
    redactionLabelCounts(input, redactDeep(input));
    assert.equal(JSON.stringify(redactDeep(input)), first);
    assert.equal(JSON.stringify(input), before, 'the input is not mutated');
    assert.equal(
      first,
      '{"command":"echo Bearer [REDACTED:bearer] [REDACTED:github-token]","env":{"API_TOKEN":"[REDACTED:secret-field]"},"list":["--password","[REDACTED:cli-flag]"]}',
    );
  });
});

describe('rulesHash', () => {
  const source = `
id: t
version: 1
description: test
state:
  sections:
    - { label: Request, from: request }
questions:
  q:
    type: noul
    instructions: Is it fine?
rules:
  - { when: { question: q, answer: 'true', minProbability: 0.9 }, action: allow }
default: ask
`;

  it('is 16 hex, stable, and changes with an override', () => {
    const policy = parsePolicy(source);
    const hash = rulesHash(policy);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(rulesHash(parsePolicy(source)), hash);
    assert.notEqual(rulesHash(withThresholds(policy, { 'q.true': 0.95 })), hash);
    assert.equal(rulesHash(withThresholds(policy, {})), hash);
  });
});
