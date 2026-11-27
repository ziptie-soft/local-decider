import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ensurePrivatePaths } from '../src/private-paths.ts';
import { tempPaths } from './helpers.ts';

describe('private runtime paths', () => {
  it('creates data, run, logs and gateway directories with private modes', () => {
    const paths = tempPaths();
    ensurePrivatePaths(paths, true);
    for (const dir of [paths.data, paths.run, paths.logs, join(paths.data, 'gateway')]) {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  });

  it('rejects a group or world writable runtime directory', () => {
    const data = mkdtempSync(join(tmpdir(), 'unsafe-'));
    const paths = { ...tempPaths(), data, run: join(data, 'run'), logs: join(data, 'logs') };
    mkdirSync(paths.run);
    chmodSync(paths.run, 0o770);
    assert.throws(() => ensurePrivatePaths(paths), /unsafe private directory/);
  });
});
