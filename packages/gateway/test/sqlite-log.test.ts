import type { Action, LogRecord, Policy, ShadowRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PrecedentStore } from '../src/precedent.ts';
import { parseProcStat, processStartToken } from '../src/process-start.ts';
import { SqliteLog } from '../src/sqlite-log.ts';
import { tempLog } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ld-sqlite-test-'));
}

function outcome(decisionId: string, overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    kind: 'outcome',
    ts: '2026-11-10T12:00:00.000Z',
    decisionId,
    outcome: 'allow',
    source: 'user',
    verified: true,
    ...overrides,
  } as LogRecord;
}

function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite');
}

function pragma(file: string, name: string): number {
  const database = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
  try {
    return Number(database.prepare(`PRAGMA ${name}`).get()?.[name]);
  } finally {
    database.close();
  }
}

function ids(records: LogRecord[]): string[] {
  return records.map((r) =>
    r.kind === 'decision'
      ? r.decisionId
      : `${r.decisionId}:${r.kind === 'outcome' ? r.outcome : ''}`,
  );
}

describe('SqliteLog', () => {
  it('discards old-format precedent keys when upgrading the existing schema', () => {
    const dir = tempDir();
    const file = join(dir, 'legacy.db');
    const old = new (sqlite().DatabaseSync)(file, { allowExtension: false });
    old.exec(
      `CREATE TABLE decision(action TEXT, precedent_key TEXT, ts INTEGER, call_id TEXT);
       INSERT INTO decision(action, precedent_key, ts) VALUES ('ask', 'old-format-key', 1);
       CREATE TABLE outcome(source TEXT, verified INTEGER);
       CREATE TABLE usage(decision_id TEXT, ts INTEGER);
       INSERT INTO usage VALUES ('legacy', 1);
       PRAGMA user_version = 1`,
    );
    old.close();
    const log = SqliteLog.open(file);
    try {
      const db = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
      try {
        assert.equal(
          db.prepare("SELECT verified FROM usage WHERE decision_id = 'legacy'").get()?.['verified'],
          1,
          'rows from before gating stay verified',
        );
        const columns = db
          .prepare('PRAGMA table_info(decision)')
          .all()
          .map((row) => row['name']);
        assert.deepEqual(
          columns.filter((name) => typeof name === 'string' && name.startsWith('precedent_key')),
          ['precedent_key'],
        );
        assert.equal(
          db.prepare('SELECT precedent_key FROM decision').get()?.['precedent_key'],
          null,
        );
        const outcomeColumns = db
          .prepare('PRAGMA table_info(outcome)')
          .all()
          .map((row) => row['name']);
        assert.ok(outcomeColumns.includes('claimed_source'));
        assert.equal(pragma(file, 'user_version'), 7);
      } finally {
        db.close();
      }
    } finally {
      log.close();
    }
  });

  it('appends and reads decisions, verified outcomes and usage', () => {
    const log = tempLog();
    try {
      const decision = makeShadowRecord('contract-decision');
      const verified = outcome(decision.decisionId, { ts: decision.ts });
      const usage: LogRecord = {
        kind: 'usage',
        ts: decision.ts,
        decisionId: decision.decisionId,
        turnId: 'turn-1',
        model: 'provider/model',
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        costUsd: 0.01,
        verified: true,
      };
      const unverifiedUsage: LogRecord = { ...usage, turnId: 'turn-2', verified: false };
      for (const record of [decision, verified, usage, unverifiedUsage]) {
        log.append(record);
      }
      assert.deepEqual(log.read(), [decision, verified, usage, unverifiedUsage]);
      assert.equal(log.findDecision(decision.decisionId)?.decisionId, decision.decisionId);
      assert.equal(log.findDecision('missing'), undefined);
    } finally {
      log.close();
    }
  });

  it('round-trips every modelSource and reads an unset one as undefined', () => {
    const log = tempLog();
    try {
      for (const source of ['default', 'policy', 'fallback', 'unavailable'] as const) {
        log.append(makeShadowRecord(`ms-${source}`, { modelSource: source }));
        assert.equal(log.findDecision(`ms-${source}`)?.modelSource, source);
      }
      log.append(makeShadowRecord('ms-none'));
      assert.equal(log.findDecision('ms-none')?.modelSource, undefined);
      assert.ok(!('modelSource' in (log.findDecision('ms-none') ?? {})));
    } finally {
      log.close();
    }
  });

  it('filters recent records by the UTC day boundary and prunes old records', async () => {
    const log = tempLog();
    try {
      log.append(makeShadowRecord('old', { ts: '2026-08-12T10:00:00.000Z' }));
      log.append(makeShadowRecord('boundary', { ts: '2026-08-13T10:00:00.000Z' }));
      log.append(makeShadowRecord('recent', { ts: '2026-11-10T10:00:00.000Z' }));
      assert.deepEqual(
        log.readRecent(2, Date.parse('2026-11-11T00:00:00.000Z')).map((r) => r.decisionId),
        ['recent'],
      );
      assert.equal(await log.prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 1);
      assert.deepEqual(
        log.read().map((r) => r.decisionId),
        ['boundary', 'recent'],
      );
    } finally {
      log.close();
    }
  });

  it('stores outcome source state and replays verified plus veto candidates', () => {
    const dir = tempDir();
    const file = join(dir, 'data', 'decider.db');
    const log = SqliteLog.open(file);
    try {
      const decision = makeShadowRecord('verified-test', {
        precedentKey: 'sha256:hash',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      log.append(
        outcome(decision.decisionId, { outcome: 'deny', source: 'unverified', verified: false }),
      );
      log.append(outcome(decision.decisionId));
      const rows = log.read().filter((row) => row.kind === 'outcome');
      assert.deepEqual(
        rows.map((row) => row.kind === 'outcome' && row.verified),
        [false, true],
      );
      const precedent = log.readVerifiedPrecedent(90, Date.parse('2026-11-11T00:00:00.000Z'));
      assert.equal(precedent.length, 3);
      assert.equal(precedent[1]?.kind === 'outcome' && precedent[1].verified, false);
      assert.equal(precedent[2]?.kind === 'outcome' && precedent[2].verified, true);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
    } finally {
      log.close();
    }
  });

  it('skips a verified unverified-source outcome like live precedent does', () => {
    const log = tempLog();
    try {
      const decision = makeShadowRecord('odd-source', {
        precedentKey: 'sha256:odd',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      log.append(outcome(decision.decisionId, { outcome: 'deny', source: 'unverified' }));
      log.append(outcome(decision.decisionId, { outcome: 'allow', source: 'user' }));
      const precedent = log.readVerifiedPrecedent(90, Date.parse('2026-11-11T00:00:00.000Z'));
      const picked = precedent[1];
      assert.equal(picked?.kind === 'outcome' && picked.source, 'user');
    } finally {
      log.close();
    }
  });

  it('keeps pending ask decisions available for a later verified outcome', () => {
    const log = tempLog();
    try {
      const decision = makeShadowRecord('pending', {
        precedentKey: 'pending-key',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      const now = Date.parse('2026-11-11T00:00:00.000Z');
      const recent = log.readVerifiedPrecedent(90, now);
      assert.deepEqual(recent, [decision]);
      const settings = {
        from: 'subject',
        minAllows: 3,
        maxAgeDays: 14,
        sources: ['user'],
        vetoSources: [],
      } satisfies NonNullable<Policy['precedent']>;
      const precedent = new PrecedentStore(
        (policy) => (policy === 'permission' ? settings : undefined),
        () => now,
      );
      precedent.rebuild(recent);
      precedent.noteOutcome(
        outcome(decision.decisionId, { ts: '2026-11-10T13:00:00.000Z' }) as never,
      );
      assert.deepEqual(precedent.tally('pending-key'), { allows: 1, denies: 0 });
    } finally {
      log.close();
    }
  });

  it('rebuilds a classifier veto after verified user allow evidence', () => {
    const log = tempLog();
    try {
      const now = Date.parse('2026-11-10T12:00:00.000Z');
      log.append(
        makeShadowRecord('ask-1', { precedentKey: 'key', ts: new Date(now).toISOString() }),
      );
      log.append(outcome('ask-1'));
      log.append(
        makeShadowRecord('auto-1', {
          action: 'allow',
          precedentKey: 'key',
          ts: new Date(now).toISOString(),
        }),
      );
      log.append(
        outcome('auto-1', {
          outcome: 'deny',
          source: 'unverified',
          claimedSource: 'classifier',
          verified: false,
        }),
      );
      const settings = {
        from: 'subject',
        minAllows: 3,
        maxAgeDays: 14,
        sources: ['user'],
        vetoSources: ['classifier'],
      } satisfies NonNullable<Policy['precedent']>;
      const precedent = new PrecedentStore(
        () => settings,
        () => now,
      );
      precedent.rebuild(log.readVerifiedPrecedent(14, now));
      assert.deepEqual(precedent.tally('key'), { allows: 1, denies: 1 });
    } finally {
      log.close();
    }
  });

  describe('readVerifiedPrecedent with typed labels', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    const hour = 3_600_000;
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
    const keyed = (
      id: string,
      action: Action,
      agoMs: number,
      key: string | null = id,
    ): ShadowRecord =>
      makeShadowRecord(id, {
        action,
        ts: at(agoMs),
        ...(key === null ? {} : { precedentKey: key }),
      });
    it('returns every verified outcome of an ask in seq order', () => {
      const log = tempLog();
      try {
        log.append(keyed('a', 'ask', 2 * hour));
        log.append(outcome('a', { outcome: 'decline', ts: at(hour) }));
        log.append(outcome('a', { outcome: 'unsafe', ts: at(0) }));
        assert.deepEqual(ids(log.readVerifiedPrecedent(14, now)), ['a', 'a:decline', 'a:unsafe']);
      } finally {
        log.close();
      }
    });

    it('orders outcomes by seq even when ts disagrees', () => {
      const log = tempLog();
      try {
        log.append(keyed('a', 'ask', 2 * hour, 'K'));
        log.append(outcome('a', { outcome: 'decline', ts: at(hour) }));
        log.append(outcome('a', { outcome: 'unsafe', ts: at(hour + 60_000) }));
        const records = log.readVerifiedPrecedent(14, now);
        assert.deepEqual(ids(records), ['a', 'a:decline', 'a:unsafe']);
        const store = new PrecedentStore(
          () => ({
            from: 'subject',
            minAllows: 3,
            maxAgeDays: 14,
            sources: ['user'],
            vetoSources: [],
          }),
          () => now,
        );
        store.rebuild(records);
        assert.deepEqual(store.tally('K'), { allows: 0, denies: 1 });
      } finally {
        log.close();
      }
    });

    it('returns a recent keyed allow with or without outcomes', () => {
      const log = tempLog();
      try {
        log.append(keyed('bare', 'allow', hour));
        log.append(keyed('labelled', 'allow', hour));
        log.append(outcome('labelled', { outcome: 'allow' }));
        log.append(outcome('labelled', { outcome: 'unsafe' }));
        assert.deepEqual(ids(log.readVerifiedPrecedent(14, now)), [
          'bare',
          'labelled',
          'labelled:allow',
          'labelled:unsafe',
        ]);
      } finally {
        log.close();
      }
    });

    it('returns an old keyed allow only with a verified veto', () => {
      const log = tempLog();
      try {
        log.append(keyed('plain', 'allow', 72 * hour));
        log.append(outcome('plain', { outcome: 'allow', ts: at(71 * hour) }));
        log.append(keyed('vetoed', 'allow', 72 * hour));
        log.append(outcome('vetoed', { outcome: 'deny', ts: at(71 * hour) }));
        assert.deepEqual(ids(log.readVerifiedPrecedent(14, now)), ['vetoed', 'vetoed:deny']);
      } finally {
        log.close();
      }
    });

    it('replays configured unverified vetoes, retaining their claimed source', () => {
      const log = tempLog();
      try {
        log.append(keyed('unkeyed', 'allow', hour, null));
        log.append(keyed('a', 'ask', hour));
        log.append(outcome('a', { outcome: 'allow', verified: false }));
        log.append(
          outcome('a', {
            outcome: 'unsafe',
            source: 'unverified',
            claimedSource: 'classifier',
            verified: false,
          }),
        );
        const records = log.readVerifiedPrecedent(14, now);
        assert.deepEqual(ids(records), ['a', 'a:unsafe']);
        assert.equal(
          records[1]?.kind === 'outcome' ? records[1].claimedSource : undefined,
          'classifier',
        );
      } finally {
        log.close();
      }
    });

    it('never returns a decision twice around the replay window', () => {
      const log = tempLog();
      try {
        log.append(keyed('inside', 'allow', 25 * hour - 60_000));
        log.append(outcome('inside', { outcome: 'unsafe', ts: at(0) }));
        log.append(keyed('outside', 'allow', 25 * hour + 60_000));
        log.append(outcome('outside', { outcome: 'unsafe', ts: at(0) }));
        const out = ids(log.readVerifiedPrecedent(14, now));
        assert.deepEqual(out.toSorted(), ['inside', 'inside:unsafe', 'outside', 'outside:unsafe']);
      } finally {
        log.close();
      }
    });
  });

  it('retention removes old orphan outcomes and usage records', async () => {
    const log = tempLog();
    try {
      log.append(outcome('missing-outcome', { ts: '2026-08-12T12:00:00.000Z' }));
      log.append({
        kind: 'usage',
        ts: '2026-08-12T12:00:00.000Z',
        decisionId: 'missing-usage',
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      });
      assert.equal(await log.prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 0);
      assert.deepEqual(log.read(), []);
    } finally {
      log.close();
    }
  });

  it('prunes orphans and unverified rows older than the unverified window', async () => {
    const log = tempLog();
    try {
      const now = Date.parse('2026-11-21T12:00:00.000Z');
      const decision = makeShadowRecord('kept', { ts: '2026-11-20T12:00:00.000Z' });
      log.append(decision);
      const row = (id: string, ts: string, verified: boolean): LogRecord[] => [
        outcome(id, { ts, verified, outcome: id }),
        {
          kind: 'usage',
          ts,
          decisionId: id,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          verified,
        },
      ];
      const old = '2026-09-01T12:00:00.000Z';
      const recent = '2026-11-20T13:00:00.000Z';
      for (const record of [
        ...row('kept', old, false),
        ...row('kept', old, true),
        ...row('kept', recent, false),
        ...row('gone', recent, true),
      ]) {
        log.append(record);
      }
      await log.prune(365, now);
      const left = log
        .read()
        .filter((r) => r.kind !== 'decision')
        .map((r) => `${r.kind}:${r.decisionId}:${r.ts.slice(0, 10)}:${String(r.verified)}`);
      assert.deepEqual(left.toSorted(), [
        'outcome:kept:2026-09-01:true',
        'outcome:kept:2026-11-20:false',
        'usage:kept:2026-09-01:true',
        'usage:kept:2026-11-20:false',
      ]);
    } finally {
      log.close();
    }
  });

  it('returns outcomes in append sequence even if timestamps move backwards', () => {
    const log = tempLog();
    try {
      log.append(outcome('same', { outcome: 'deny', ts: '2026-11-10T12:00:00.000Z' }));
      log.append(outcome('same', { outcome: 'allow', ts: '2026-11-09T12:00:00.000Z' }));
      assert.deepEqual(
        log
          .read()
          .filter((record) => record.kind === 'outcome')
          .map((record) => record.outcome),
        ['deny', 'allow'],
      );
    } finally {
      log.close();
    }
  });

  it('exports daily JSONL files filtered by --since', () => {
    const log = tempLog();
    try {
      const first = makeShadowRecord('first', { ts: '2026-11-09T12:00:00.000Z' });
      const second = makeShadowRecord('second', { ts: '2026-11-10T12:00:00.000Z' });
      log.append(first);
      log.append(second);
      const all = join(tempDir(), 'all');
      log.exportDirectory(all);
      assert.deepEqual(readdirSync(all).toSorted(), [
        'decisions-2026-11-09.jsonl',
        'decisions-2026-11-10.jsonl',
      ]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(all, 'decisions-2026-11-10.jsonl'), 'utf8')),
        second,
      );
      assert.equal(statSync(join(all, 'decisions-2026-11-10.jsonl')).mode & 0o777, 0o600);
      const since = join(tempDir(), 'since');
      log.exportDirectory(since, '2026-11-10');
      assert.deepEqual(readdirSync(since), ['decisions-2026-11-10.jsonl']);
    } finally {
      log.close();
    }
  });

  it('serves a read-only handle and backups while a writer is open, and refuses a second writer', () => {
    const dir = tempDir();
    const file = join(dir, 'decider.db');
    const lockPath = join(dir, 'db.lock');
    const writer = SqliteLog.open(file, { lockPath });
    const reader = SqliteLog.open(file, { readOnly: true });
    try {
      writer.append(makeShadowRecord('first'));
      writer.flush();
      assert.deepEqual(
        reader.read().map((row) => row.decisionId),
        ['first'],
      );
      writer.append(makeShadowRecord('second'));
      writer.flush();
      assert.deepEqual(
        reader.read().map((row) => row.decisionId),
        ['first', 'second'],
      );
      const backup = join(dir, 'read-only-backup.db');
      const previousUmask = process.umask(0o022);
      try {
        reader.backup(backup);
      } finally {
        process.umask(previousUmask);
      }
      assert.equal(statSync(backup).mode & 0o777, 0o600);
      const original = join(dir, 'existing-backup.db');
      writeFileSync(original, 'keep this file', { mode: 0o600 });
      assert.throws(() => reader.backup(original), /EEXIST/);
      assert.equal(readFileSync(original, 'utf8'), 'keep this file');
      assert.throws(() => SqliteLog.open(file, { lockPath }), /locked by another writer/);
    } finally {
      reader.close();
      writer.close();
    }
    SqliteLog.open(file, { lockPath }).close();
  });

  it(
    'treats a lock whose pid was recycled (start token differs) as stale',
    { skip: processStartToken(process.pid) === undefined },
    () => {
      const dir = tempDir();
      const file = join(dir, 'decider.db');
      const lockPath = join(dir, 'db.lock');
      const start = processStartToken(process.pid) as string;
      writeFileSync(lockPath, `${String(process.pid)}\n${start}\n`, { mode: 0o600 });
      assert.throws(() => SqliteLog.open(file, { lockPath }), /locked by another writer/);
      writeFileSync(lockPath, `${String(process.pid)}\n${start}-recycled\n`, { mode: 0o600 });
      const log = SqliteLog.open(file, { lockPath });
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; start: string };
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.start, start);
      } finally {
        log.close();
      }
    },
  );

  it('keeps a lock without a start token (older format) held while its pid runs', () => {
    const dir = tempDir();
    const lockPath = join(dir, 'db.lock');
    writeFileSync(lockPath, `${String(process.pid)}\n`, { mode: 0o600 });
    assert.throws(
      () => SqliteLog.open(join(dir, 'decider.db'), { lockPath }),
      /locked by another writer/,
    );
  });

  it('parses the start time out of /proc stat even when comm has spaces and parentheses', () => {
    const fields = Array.from({ length: 30 }, (_, i) => String(i + 3));
    assert.equal(parseProcStat(`123 (we ) ird (x) ${fields.join(' ')}`), '22');
    assert.equal(parseProcStat('garbage'), undefined);
  });

  it('refuses a read-only open of a missing database', () => {
    assert.throws(
      () => SqliteLog.open(join(tempDir(), 'missing.db'), { readOnly: true }),
      /does not exist/,
    );
  });

  it('migrates a version-0 database via user_version and creates the ts indexes', () => {
    const dir = tempDir();
    const file = join(dir, 'decider.db');
    new (sqlite().DatabaseSync)(file, { allowExtension: false }).close();
    assert.equal(pragma(file, 'user_version'), 0);
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'user_version'), 7);
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'user_version'), 7);
    const database = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
    try {
      const names = database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all()
        .map((row) => row['name']);
      for (const index of ['decision_ts', 'outcome_ts', 'usage_ts']) {
        assert.ok(names.includes(index), index);
      }
    } finally {
      database.close();
    }
  });

  it('turns on incremental auto-vacuum for a file that already had tables', () => {
    const file = join(tempDir(), 'decider.db');
    const database = new (sqlite().DatabaseSync)(file, { allowExtension: false });
    database.exec('CREATE TABLE stray(x INTEGER)');
    database.close();
    assert.equal(pragma(file, 'auto_vacuum'), 0);
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'auto_vacuum'), 2);
  });

  it('refuses a database from a newer schema', () => {
    const file = join(tempDir(), 'decider.db');
    const database = new (sqlite().DatabaseSync)(file, { allowExtension: false });
    database.exec('PRAGMA user_version = 99');
    database.close();
    assert.throws(() => SqliteLog.open(file), /newer than this build supports/);
  });

  it('uses incremental auto-vacuum and WAL on new databases', () => {
    const file = join(tempDir(), 'nested', 'decider.db');
    mkdirSync(join(file, '..'), { recursive: true });
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'auto_vacuum'), 2);
    assert.equal(
      new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true })
        .prepare('PRAGMA journal_mode')
        .get()?.['journal_mode'],
      'wal',
    );
  });

  describe('F6 migration (v5 → v6)', () => {
    const V5_SCHEMA = `
      CREATE TABLE decision(
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, policy TEXT NOT NULL, variant TEXT,
        mode TEXT NOT NULL, scope TEXT, harness TEXT NOT NULL, session_id TEXT, call_id TEXT,
        permission_mode TEXT, subagent INTEGER, input_hash TEXT NOT NULL,
        precedent_key TEXT, template_key TEXT, state_tokens INTEGER,
        action TEXT NOT NULL, enforced INTEGER NOT NULL, engine TEXT, model TEXT,
        latency_ms INTEGER, queue_ms INTEGER, engine_ms INTEGER, error TEXT, power TEXT,
        requested_model TEXT, routed_model TEXT, answers TEXT NOT NULL, truncated TEXT) STRICT;
      CREATE INDEX decision_ts ON decision(ts);
      CREATE INDEX decision_policy_ts ON decision(policy, ts);
      CREATE TABLE outcome(
        seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL,
        claimed_source TEXT) STRICT;
      CREATE INDEX outcome_ts ON outcome(ts);
      CREATE INDEX outcome_decision ON outcome(decision_id, seq);
      CREATE TABLE usage(
        seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL, turn_id TEXT,
        model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cost_usd REAL, verified INTEGER NOT NULL DEFAULT 1) STRICT;
      CREATE INDEX usage_ts ON usage(ts);
      CREATE INDEX usage_decision ON usage(decision_id);
      INSERT INTO decision(id, ts, policy, mode, harness, call_id, input_hash, action, enforced,
        engine, model, latency_ms, answers)
        VALUES ('old-1', 1763424000000, 'permission', 'shadow', 'claude-code', 'toolu_old',
        'hash', 'ask', 0, 'fake', 'fake', 5, '{}');
      PRAGMA user_version = 5;`;

    function fixture(): string {
      const file = join(tempDir(), 'decider.db');
      const old = new (sqlite().DatabaseSync)(file, { allowExtension: false });
      old.exec(V5_SCHEMA);
      old.close();
      return file;
    }

    it('adds the columns and call index, keeps old rows and is a no-op the second time', () => {
      const file = fixture();
      const log = SqliteLog.open(file);
      try {
        const old = log.findDecision('old-1');
        assert.equal(old?.action, 'ask');
        for (const key of ['rule', 'cached', 'precedent', 'redactions', 'rulesHash', 'tool']) {
          assert.equal(old !== undefined && key in old, false, `${key} stays absent`);
        }
        assert.deepEqual(
          log.findByCall('toolu_old').map((record) => record.decisionId),
          ['old-1'],
        );
      } finally {
        log.close();
      }
      assert.equal(pragma(file, 'user_version'), 7);
      const again = SqliteLog.open(file);
      again.close();
      assert.equal(pragma(file, 'user_version'), 7);
      const database = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
      try {
        const columns = database
          .prepare('PRAGMA table_info(decision)')
          .all()
          .map((row) => row['name']);
        for (const name of [
          'rule',
          'cached',
          'precedent_allows',
          'precedent_denies',
          'redactions',
          'rules_hash',
          'tool',
        ]) {
          assert.equal(columns.filter((column) => column === name).length, 1, name);
        }
        const names = database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
          .all()
          .map((row) => row['name']);
        assert.ok(names.includes('decision_call'));
      } finally {
        database.close();
      }
      assert.ok(
        readdirSync(join(file, '..')).some((name) => name.includes('.pre-v5-')),
        'a pre-migration backup was written',
      );
    });

    it('makes a read-only open ask for the gateway to migrate first', () => {
      const file = fixture();
      assert.throws(
        () => SqliteLog.open(file, { readOnly: true }),
        /start the gateway once to migrate/,
      );
    });

    it('round-trips the new fields and decodes NULL as absent', () => {
      const log = tempLog();
      try {
        const full = makeShadowRecord('full', {
          rule: 2,
          cached: true,
          precedent: { allows: 3, denies: 1 },
          redactions: { 'bearer': 1, 'secret-field': 2 },
          rulesHash: '0123456789abcdef',
          tool: 'Bash',
          callId: 'call-1',
        });
        const sparse = makeShadowRecord('sparse', { rule: -1, cached: false, callId: 'call-1' });
        log.append(full);
        log.append(sparse);
        log.flush();
        assert.deepEqual(log.findDecision('full'), full);
        assert.deepEqual(
          log.read().filter((r) => r.kind === 'decision'),
          [full, sparse],
        );
        assert.equal(log.findDecision('sparse')?.precedent, undefined);
        assert.equal(log.findDecision('sparse')?.rule, -1);
        assert.equal(log.findDecision('sparse')?.cached, false);
      } finally {
        log.close();
      }
    });

    it('reads outcomes in seq order, usage, and decisions by call with a limit', () => {
      const log = tempLog();
      try {
        for (const id of ['a', 'b', 'c']) {
          log.append(
            makeShadowRecord(id, {
              callId: 'shared',
              ts: `2026-11-10T00:00:0${id === 'a' ? 1 : id === 'b' ? 2 : 3}.000Z`,
            }),
          );
        }
        log.append(outcome('a', { outcome: 'deny', ts: '2026-11-10T01:00:00.000Z' }));
        log.append(outcome('a', { outcome: 'allow', ts: '2026-11-10T00:30:00.000Z' }));
        log.append(outcome('b'));
        const usage: LogRecord = {
          kind: 'usage',
          ts: '2026-11-10T02:00:00.000Z',
          decisionId: 'a',
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          verified: false,
        };
        log.append(usage);
        assert.deepEqual(
          log.findOutcomes('a').map((record) => record.outcome),
          ['deny', 'allow'],
        );
        assert.deepEqual(log.findUsage('a'), [usage]);
        assert.deepEqual(log.findUsage('b'), []);
        assert.deepEqual(
          log.findByCall('shared', 2).map((record) => record.decisionId),
          ['a', 'b'],
        );
        assert.equal(log.findByCall('shared').length, 3);
        assert.deepEqual(log.findByCall('none'), []);
      } finally {
        log.close();
      }
    });
  });
});
