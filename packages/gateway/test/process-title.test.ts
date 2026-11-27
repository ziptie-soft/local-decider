import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { processTitle, titleApplies } from '../src/process-title.ts';

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

describe('titleApplies', () => {
  it('skips shims and symlinks to a binary of another name, which dispatch on argv[0]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ld-title-'));
    const mise = join(dir, 'mise');
    writeFileSync(mise, '');
    const shims = join(dir, 'shims');
    const link = join(dir, 'llama-server');
    symlinkSync(mise, link);
    assert.equal(titleApplies(process.execPath), true);
    assert.equal(titleApplies(mise), true);
    assert.equal(titleApplies(link), false);
    assert.equal(titleApplies(join(shims, 'llama-server')), false);
    assert.equal(titleApplies(join(dir, 'missing')), false);
  });
});
