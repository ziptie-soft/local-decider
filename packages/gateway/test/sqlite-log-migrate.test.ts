import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { SqliteLog } from '../src/sqlite-log.ts';
import { makeShadowRecord } from './records.ts';

type Db = InstanceType<typeof import('node:sqlite').DatabaseSync>;

function openAt(file: string, readOnly = false): Db {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  return new DatabaseSync(file, { allowExtension: false, readOnly });
}

function version(file: string): number {
  const db = openAt(file, true);
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  } finally {
    db.close();
  }
}

/** A database at schema v4 (before `usage.verified`), holding one decision. */
function v4(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ld-migrate-test-'));
  const file = join(dir, 'decider.db');
  const log = SqliteLog.open(file);
  log.append(makeShadowRecord('old-row'));
  log.close();
  const db = openAt(file);
  db.exec('DROP INDEX decision_call');
  for (const column of [
    'rule',
    'cached',
    'precedent_allows',
    'precedent_denies',
    'redactions',
    'rules_hash',
    'tool',
  ]) {
    db.exec(`ALTER TABLE decision DROP COLUMN ${column}`);
  }
  db.exec('ALTER TABLE usage DROP COLUMN verified');
  db.exec('PRAGMA user_version = 4');
  db.close();
  return { dir, file };
}

const backups = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.bak'));

describe('schema migration backup', () => {
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it('leaves one private backup at the old version', () => {
    const { dir, file } = v4();
    SqliteLog.open(file).close();
    assert.equal(version(file), 6);
    const [name, ...rest] = backups(dir);
    assert.equal(rest.length, 0);
    assert.match(name ?? '', /^decider\.db\.pre-v4-\d{8}T\d{6}\.bak$/);
    const backup = join(dir, name ?? '');
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(version(backup), 4);
  });

  it('keeps the newest three backups', () => {
    const { dir, file } = v4();
    for (const day of ['01', '02', '03']) {
      writeFileSync(join(dir, `decider.db.pre-v1-202601${day}T000000.bak`), 'x');
    }
    SqliteLog.open(file).close();
    const left = backups(dir).toSorted();
    assert.equal(left.length, 3);
    assert.ok(!left.some((name) => name.includes('20260101')));
  });

  it('warns and migrates anyway when the backup fails', () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T10:00:00.000Z') });
    const errors = mock.method(console, 'error', () => undefined);
    const { dir, file } = v4();
    writeFileSync(join(dir, 'decider.db.pre-v4-20261122T100000.bak'), 'in the way');
    const log = SqliteLog.open(file);
    try {
      assert.equal(version(file), 6);
      assert.equal(log.findDecision('old-row')?.decisionId, 'old-row');
      assert.match(
        String(errors.mock.calls[0]?.arguments[0]),
        /could not back up .* before migrating schema v4 → v6 .*migrating anyway/,
      );
    } finally {
      log.close();
    }
  });

  it('takes no backup of a new or current database', () => {
    const { dir, file } = v4();
    SqliteLog.open(file).close();
    const before = backups(dir).length;
    SqliteLog.open(file).close();
    assert.equal(backups(dir).length, before);
  });
});

function atVersion(user: number): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ld-version-test-')), 'decider.db');
  const db = openAt(file);
  db.exec(`PRAGMA user_version = ${String(user)}`);
  db.close();
  return file;
}

describe('schema version checks', () => {
  it('refuses a newer schema for writers and readers, naming the remedy and file', () => {
    const file = atVersion(99);
    const message =
      /newer than this build supports \(6\): upgrade local-decider or restore a backup/;
    assert.throws(() => SqliteLog.open(file), message);
    assert.throws(() => SqliteLog.open(file, { readOnly: true }), message);
    assert.throws(() => SqliteLog.open(file, { readOnly: true }), new RegExp(file));
  });

  it('refuses to read an older schema without migrating', () => {
    const file = atVersion(4);
    assert.throws(
      () => SqliteLog.open(file, { readOnly: true }),
      /version 4 is older than this build \(6\); start the gateway once to migrate/,
    );
    assert.equal(version(file), 4);
  });
});
