import type { LogRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { startGateway } from '../src/runtime.ts';
import { openLogStore, SqliteLog } from '../src/sqlite-log.ts';
import { FakeEngine, tempPaths, testConfig } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

type Db = InstanceType<typeof import('node:sqlite').DatabaseSync>;

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const OLD = '2026-01-01T12:00:00.000Z';
const RECENT = '2026-11-20T12:00:00.000Z';

function openAt(file: string): Db {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  return new DatabaseSync(file, { allowExtension: false });
}

function fileOf(): string {
  return join(mkdtempSync(join(tmpdir(), 'ld-prune-test-')), 'decider.db');
}

function count(db: Db, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

function family(id: string, ts: string): LogRecord[] {
  return [
    makeShadowRecord(id, { ts }),
    { kind: 'outcome', ts, decisionId: id, outcome: 'allow', source: 'user', verified: true },
    {
      kind: 'usage',
      ts,
      decisionId: id,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      verified: true,
    },
  ];
}

function seed(log: SqliteLog, total: number, ts: string, prefix: string): void {
  for (let index = 0; index < total; index += 1) {
    for (const record of family(`${prefix}${String(index)}`, ts)) {
      log.append(record);
    }
    if (index % 500 === 499) {
      log.flush();
    }
  }
  log.flush();
}

describe('SqliteLog chunked prune', () => {
  afterEach(() => mock.restoreAll());

  it('removes thousands of old rows over several steps, yielding to the event loop', async () => {
    const file = fileOf();
    const log = SqliteLog.open(file);
    const raw = openAt(file);
    try {
      seed(log, 5000, OLD, 'old');
      seed(log, 2, RECENT, 'new');
      let turns = 0;
      let running = true;
      const spin = (): void => {
        turns += 1;
        if (running) setImmediate(spin);
      };
      spin();
      const deleted = await log.prune(90, NOW);
      running = false;
      assert.equal(deleted, 5000);
      assert.ok(turns > 1, `event loop turned ${String(turns)} times`);
      assert.equal(count(raw, 'decision'), 2);
      assert.equal(count(raw, 'outcome'), 2);
      assert.equal(count(raw, 'usage'), 2);
    } finally {
      raw.close();
      log.close();
    }
  });

  it('sweeps orphans and aged unverified rows, and keeps appends made meanwhile', async () => {
    const file = fileOf();
    const log = SqliteLog.open(file);
    const raw = openAt(file);
    try {
      log.append(makeShadowRecord('kept', { ts: RECENT }));
      log.append({
        kind: 'outcome',
        ts: RECENT,
        decisionId: 'ghost',
        outcome: 'allow',
        source: 'user',
        verified: true,
      });
      log.append({
        kind: 'outcome',
        ts: '2026-09-01T12:00:00.000Z',
        decisionId: 'kept',
        outcome: 'allow',
        source: 'unverified',
        verified: false,
      });
      const pruning = log.prune(365, NOW);
      log.append(makeShadowRecord('during', { ts: RECENT }));
      await pruning;
      log.flush();
      assert.equal(count(raw, 'decision'), 2);
      assert.equal(count(raw, 'outcome'), 0);
    } finally {
      raw.close();
      log.close();
    }
  });

  it('logs a vacuum failure and still resolves with the deleted count', async () => {
    const file = fileOf();
    SqliteLog.open(file).close();
    const database = openAt(file);
    const failing = {
      exec: (sql: string): void => {
        if (sql.includes('incremental_vacuum')) throw new Error('disk on fire');
        database.exec(sql);
      },
      prepare: (sql: string) => database.prepare(sql),
      close: (): void => database.close(),
    };
    const log = new SqliteLog(failing);
    const errors = mock.method(console, 'error', () => undefined);
    try {
      seed(log, 600, OLD, 'old');
      assert.equal(await log.prune(90, NOW), 600);
      assert.match(
        String(errors.mock.calls.at(-1)?.arguments[0]),
        /log vacuum failed: disk on fire/,
      );
    } finally {
      log.close();
    }
  });

  it('opens a legacy file when the one-time VACUUM fails, and says so', () => {
    const file = fileOf();
    const holder = openAt(file);
    holder.exec('PRAGMA journal_mode=WAL');
    holder.exec('PRAGMA user_version = 5');
    holder.exec('BEGIN IMMEDIATE');
    const errors = mock.method(console, 'error', () => undefined);
    try {
      SqliteLog.open(file).close();
      assert.match(
        String(errors.mock.calls[0]?.arguments[0]),
        /could not enable incremental vacuum .*pruning will not reclaim space/,
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

function ids(records: LogRecord[]): string[] {
  return records.map((r) => r.decisionId);
}

function corrupted(): { log: SqliteLog; file: string } {
  const file = fileOf();
  const log = SqliteLog.open(file);
  const now = new Date().toISOString();
  for (const id of ['good', 'bad']) {
    log.append(makeShadowRecord(id, { ts: now, action: 'ask', precedentKey: `k-${id}` }));
    log.append({
      kind: 'outcome',
      ts: now,
      decisionId: id,
      outcome: 'allow',
      source: 'user',
      verified: true,
    });
  }
  log.flush();
  const raw = openAt(file);
  raw.exec("UPDATE decision SET answers = '{not json' WHERE id = 'bad'");
  raw.close();
  return { log, file };
}

describe('unreadable rows', () => {
  afterEach(() => mock.restoreAll());

  it('skips the decision and its outcomes, logging once per read', () => {
    const errors = mock.method(console, 'error', () => undefined);
    const { log } = corrupted();
    try {
      assert.deepEqual(ids(log.read()), ['good', 'good']);
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /skipped 1 unreadable rows/);
      assert.deepEqual(ids(log.readRecent(30)), ['good', 'good']);
      assert.deepEqual(ids(log.readVerifiedPrecedent(30)), ['good', 'good']);
      assert.equal(errors.mock.callCount(), 3);
      assert.equal(log.findDecision('bad'), undefined);
      assert.equal(log.findDecision('good')?.decisionId, 'good');
    } finally {
      log.close();
    }
  });

  it('still lets the gateway start', async () => {
    mock.method(console, 'error', () => undefined);
    const paths = tempPaths();
    const log = openLogStore(paths);
    log.append(makeShadowRecord('bad', { ts: new Date().toISOString(), precedentKey: 'k' }));
    log.close();
    const raw = openAt(join(paths.data, 'decider.db'));
    raw.exec("UPDATE decision SET answers = 'null' WHERE id = 'bad'");
    raw.close();
    const gateway = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine({ allow: 0.9, ask: 0.1 }),
      env: {},
    });
    await gateway.close();
  });
});
