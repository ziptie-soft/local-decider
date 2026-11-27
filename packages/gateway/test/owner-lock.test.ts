import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { acquireOwnerLock, readOwnerLock, releaseOwnerLock } from '../src/owner-lock.ts';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'owner-lock-')), 'db.lock');
}

describe('owner lock', () => {
  it('publishes a complete record and releases only its own nonce', () => {
    const path = lockPath();
    const lock = acquireOwnerLock(path);
    const owner = readOwnerLock(path);
    assert.equal(owner?.pid, process.pid);
    assert.equal(owner?.nonce, lock.nonce);
    writeFileSync(path, JSON.stringify({ pid: 123, start: 'old', nonce: 'foreign' }));
    releaseOwnerLock(lock);
    assert.equal(readOwnerLock(path)?.nonce, 'foreign');
  });

  it('takes over malformed and empty locks', () => {
    for (const value of ['', '{broken']) {
      const path = lockPath();
      writeFileSync(path, value, { mode: 0o600 });
      const lock = acquireOwnerLock(path);
      assert.equal(readOwnerLock(path)?.nonce, lock.nonce);
      releaseOwnerLock(lock);
    }
  });

  it('takes over a dead pid and a reused pid with a different start token', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 456, start: 'old', nonce: 'stale' }));
    const lock = acquireOwnerLock(path, {
      isAlive: () => true,
      startToken: () => 'new',
    });
    assert.equal(readOwnerLock(path)?.nonce, lock.nonce);
    releaseOwnerLock(lock);
    writeFileSync(path, JSON.stringify({ pid: 456, start: 'old', nonce: 'dead' }));
    const dead = acquireOwnerLock(path, { isAlive: () => false });
    assert.equal(readOwnerLock(path)?.nonce, dead.nonce);
    releaseOwnerLock(dead);
  });

  it('restores a replacement acquired during stale takeover and gives up', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 456, start: 'old', nonce: 'stale' }));
    const foreign = JSON.stringify({ pid: 789, start: 'new', nonce: 'foreign' });
    assert.throws(
      () =>
        acquireOwnerLock(path, {
          isAlive: () => false,
          beforeTakeover: () => writeFileSync(path, foreign),
        }),
      /locked by another writer/,
    );
    assert.equal(readFileSync(path, 'utf8'), foreign);
  });
});
