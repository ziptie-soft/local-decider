import type { LogRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

function fresh(): { log: SqliteLog; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'ld-queue-test-')), 'decider.db');
  return { log: SqliteLog.open(file), file };
}

function outcome(decisionId: string, ts: string): LogRecord {
  return { kind: 'outcome', ts, decisionId, outcome: 'allow', source: 'user', verified: true };
}

function count(db: Db, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

function dataVersion(db: Db): number {
  return Number(db.prepare('PRAGMA data_version').get()?.['data_version']);
}

describe('SqliteLog write queue', () => {
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it('writes appends in one transaction on flush', () => {
    const { log, file } = fresh();
    const observer = openAt(file, true);
    try {
      const before = dataVersion(observer);
      for (const id of ['a', 'b', 'c']) {
        log.append(makeShadowRecord(id));
      }
      assert.equal(count(observer, 'decision'), 0, 'nothing is written at append');
      log.flush();
      assert.equal(count(observer, 'decision'), 3);
      assert.equal(dataVersion(observer), before + 1, 'one commit for the batch');
      const settled = dataVersion(observer);
      log.flush();
      assert.equal(dataVersion(observer), settled, 'an empty flush is a no-op');
    } finally {
      observer.close();
      log.close();
    }
  });

  it('finds an unflushed decision and reads see queued records', () => {
    const { log } = fresh();
    try {
      const record = makeShadowRecord('queued');
      log.append(record);
      assert.equal(log.findDecision('queued')?.decisionId, 'queued');
      assert.equal(log.read().length, 1);
    } finally {
      log.close();
    }
  });

  it('keeps FIFO order so an outcome follows its decision', () => {
    const { log, file } = fresh();
    try {
      const decision = makeShadowRecord('ordered');
      log.append(decision);
      log.append(outcome('ordered', decision.ts));
      log.flush();
      const observer = openAt(file, true);
      try {
        assert.equal(count(observer, 'decision'), 1);
        assert.equal(count(observer, 'outcome'), 1);
      } finally {
        observer.close();
      }
      assert.deepEqual(
        log.read().map((r) => r.kind),
        ['decision', 'outcome'],
      );
    } finally {
      log.close();
    }
  });

  it('writes by itself after the flush delay', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { log, file } = fresh();
    const observer = openAt(file, true);
    try {
      log.append(makeShadowRecord('timed'));
      assert.equal(count(observer, 'decision'), 0);
      mock.timers.tick(25);
      assert.equal(count(observer, 'decision'), 1);
    } finally {
      observer.close();
      log.close();
    }
  });

  it('close flushes', () => {
    const { log, file } = fresh();
    log.append(makeShadowRecord('closing'));
    log.close();
    const observer = openAt(file, true);
    try {
      assert.equal(count(observer, 'decision'), 1);
    } finally {
      observer.close();
    }
  });

  it('keeps a failed batch, logs once and retries with backoff', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const errors = mock.method(console, 'error', () => undefined);
    const { log, file } = fresh();
    const saboteur = openAt(file);
    try {
      saboteur.exec('ALTER TABLE outcome RENAME TO outcome_away');
      const decision = makeShadowRecord('retried');
      log.append(decision);
      log.append(outcome('retried', decision.ts));
      mock.timers.tick(25);
      mock.timers.tick(50);
      mock.timers.tick(100);
      assert.equal(errors.mock.callCount(), 1, 'a run of failures logs one line');
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /write failed, 2 records queued/);
      assert.equal(count(saboteur, 'decision'), 0, 'the rolled-back batch left nothing behind');
      assert.equal(log.findDecision('retried')?.decisionId, 'retried');
      saboteur.exec('ALTER TABLE outcome_away RENAME TO outcome');
      mock.timers.tick(5000);
      assert.equal(count(saboteur, 'decision'), 1);
      assert.equal(count(saboteur, 'outcome'), 1);
    } finally {
      saboteur.close();
      log.close();
    }
  });

  it('skips a row that violates a constraint instead of blocking the queue', () => {
    const errors = mock.method(console, 'error', () => undefined);
    const { log } = fresh();
    try {
      log.append(makeShadowRecord('dup'));
      log.flush();
      log.append(makeShadowRecord('dup'));
      log.append(makeShadowRecord('after'));
      log.flush();
      assert.equal(log.read().length, 2);
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /skipped a row/);
    } finally {
      log.close();
    }
  });

  it('drops the newest records beyond the queue limit and counts them', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const errors = mock.method(console, 'error', () => undefined);
    const { log, file } = fresh();
    const saboteur = openAt(file);
    try {
      saboteur.exec('ALTER TABLE outcome RENAME TO outcome_away');
      const decision = makeShadowRecord('limit');
      for (let index = 0; index < 10_003; index += 1) {
        log.append(outcome(`o${String(index)}`, decision.ts));
      }
      mock.timers.tick(0);
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /dropped 3 records/);
      saboteur.exec('ALTER TABLE outcome_away RENAME TO outcome');
      mock.timers.tick(5000);
      assert.equal(count(saboteur, 'outcome'), 10_000);
    } finally {
      saboteur.close();
      log.close();
    }
  });
});

function ids(records: Iterable<LogRecord>): string[] {
  return [...records].map((r) => `${r.kind}:${r.decisionId}`);
}

describe('SqliteLog.iterateRecent', () => {
  it('streams the window with probes and other scopes filtered out in SQL', () => {
    const { log } = fresh();
    try {
      const ts = new Date().toISOString();
      log.append(makeShadowRecord('real', { ts, scope: 'claude-auto' }));
      log.append(makeShadowRecord('other-scope', { ts }));
      log.append(makeShadowRecord('probe', { ts, harness: 'mcp' }));
      log.append(outcome('real', ts));
      assert.deepEqual(ids(log.iterateRecent(30)).toSorted(), [
        'decision:other-scope',
        'decision:real',
        'outcome:real',
      ]);
      assert.deepEqual(ids(log.iterateRecent(30, 'claude-auto')), [
        'decision:real',
        'outcome:real',
      ]);
    } finally {
      log.close();
    }
  });
});
