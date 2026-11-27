import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { patchTargets } from '../src/patch.ts';
import { LINEAR_BOUND_MS, cpuMs } from './cpu-time.ts';

describe('patchTargets', () => {
  it('reads the four markers in order', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+x',
      '*** Update File: b.ts',
      '*** Move to: c.ts',
      '*** Delete File: d.ts',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(patchTargets(text), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });

  it('copes with CRLF, leading whitespace and a heredoc wrapper', () => {
    assert.deepEqual(patchTargets('*** Add File: a.ts\r\n*** Delete File:  b.ts \r\n'), [
      'a.ts',
      'b.ts',
    ]);
    assert.deepEqual(patchTargets('  \t*** Update File: a.ts\n'), ['a.ts']);
    assert.deepEqual(patchTargets("apply_patch <<'EOF'\n*** Update File: a.ts\nEOF"), ['a.ts']);
  });

  it('ignores marker text inside a hunk', () => {
    assert.deepEqual(patchTargets('*** Update File: a.ts\n+*** Add File: evil\n-*** Move to: x'), [
      'a.ts',
    ]);
  });

  it('returns [] for no targets and null over the cap', () => {
    assert.deepEqual(patchTargets(''), []);
    assert.deepEqual(patchTargets('*** Begin Patch\n*** End Patch'), []);
    const lines = Array.from({ length: 5 }, (_, i) => `*** Add File: f${i}`).join('\n');
    assert.equal(patchTargets(lines, 4), null);
    assert.equal(patchTargets(lines, 5)?.length, 5);
  });

  it('is linear on one 4 MiB line', () => {
    const text = `*** Add File: ${'a'.repeat(4 * 1024 * 1024)}`;
    const ms = cpuMs(() => assert.equal(patchTargets(text)?.length, 1));
    assert.ok(ms < LINEAR_BOUND_MS, `took ${ms} ms`);
  });

  it('is linear on 100k marker lines', () => {
    const text = '*** Add File: a\n'.repeat(100_000);
    const ms = cpuMs(() => {
      assert.equal(patchTargets(text), null);
      assert.equal(patchTargets(text, 200_000)?.length, 100_000);
    });
    assert.ok(ms < LINEAR_BOUND_MS, `took ${ms} ms`);
  });
});
