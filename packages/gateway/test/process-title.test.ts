import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processTitle } from '../src/process-title.ts';

describe('processTitle', () => {
  it('keeps configured model identifiers printable, bounded and path-free', () => {
    assert.equal(
      processTitle('strands', 'org/model:v1@cpu+fast'),
      'local-decider: strands org/model:v1@cpu+fast',
    );
    const title = processTitle('engine', `${'/private/home/'.repeat(20)}model`);
    assert.ok(title.length <= 64);
    assert.match(title, /^[A-Za-z0-9._:/@+\- ]+$/);
    assert.equal(processTitle('llama', 'm\nsecret'), 'local-decider: llama m_secret');
  });
});
