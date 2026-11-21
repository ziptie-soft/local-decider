import type {
  LogRecord,
  OutcomeRecord,
  Scope,
  ShadowRecord,
  UsageRecord,
} from '@ziptie-soft/local-decider-core';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { LogStore } from './log-store.ts';
import { ALLOW_VETO_REPLAY_MS } from './outcome-labels.ts';
import type { Paths } from './paths.ts';
import { pruneDatabase } from './sqlite-prune.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Unverified outcome and usage rows are dropped at prune after this many days at most. */
const UNVERIFIED_RETAIN_DAYS = 30;

/** Appends are batched: one transaction per flush, started this long after the first enqueue. */
const FLUSH_DELAY_MS = 25;
const FLUSH_MAX_BATCH = 256;
const FLUSH_RETRY_MAX_MS = 5000;
const FLUSH_ERROR_LOG_INTERVAL_MS = 60_000;
/** Records queued beyond this many (the store is failing) are dropped, newest first. */
const PENDING_MAX = 10_000;
/** SQLite primary result code of a constraint violation (extended codes keep it in the low byte). */
const SQLITE_CONSTRAINT = 19;

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
type Row = Record<string, SqlValue>;

interface Statement {
  run(...values: SqlValue[]): { changes: number | bigint };
  all(...values: SqlValue[]): Row[];
  get(...values: SqlValue[]): Row | undefined;
  iterate(...values: SqlValue[]): IterableIterator<Row>;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface DatabaseOptions {
  readonly allowExtension: false;
  readonly readOnly?: boolean;
  readonly timeout?: number;
}

type DatabaseConstructor = new (path: string, options: DatabaseOptions) => Database;

interface DatabaseModule {
  readonly Database?: DatabaseConstructor;
  readonly DatabaseSync?: DatabaseConstructor;
}

/** A bound insert waiting for the next flush. */
interface PendingWrite {
  readonly sql: string;
  readonly params: SqlValue[];
  readonly decision?: ShadowRecord;
}

interface Lock {
  readonly path: string;
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
}

export interface OpenLogOptions {
  readonly readOnly?: boolean;
  /** Writers hold this pid lock file so a second gateway cannot open the same database. */
  readonly lockPath?: string;
}

/** The single durable store, backed by `node:sqlite`. */
export class SqliteLog implements LogStore {
  readonly #database: Database;
  readonly #lock: Lock | undefined;
  readonly #statements = new Map<string, Statement>();
  #pending: PendingWrite[] = [];
  readonly #pendingDecisions = new Map<string, ShadowRecord>();
  #timer: NodeJS.Timeout | undefined;
  #retries = 0;
  #dropped = 0;
  #lastErrorLog: number | undefined;
  #pruning: Promise<number> | undefined;
  #closed = false;

  constructor(database: Database, lock?: Lock) {
    this.#database = database;
    this.#lock = lock;
  }

  /** Synchronous: throws a clear error when `node:sqlite` is unavailable. */
  static open(file: string, options: OpenLogOptions = {}): SqliteLog {
    ensureSupportedNode();
    return openDatabase(loadDatabase(), file, options);
  }

  append(record: LogRecord): void {
    let write: PendingWrite;
    try {
      write = bindRecord(record);
    } catch (error) {
      // A storage problem must not turn a decision into an enforcement failure.
      console.error(`sqlite log: ${errorMessage(error)}`);
      return;
    }
    if (this.#closed) {
      console.error('sqlite log: record appended after close was dropped');
      return;
    }
    if (this.#pending.length >= PENDING_MAX) {
      this.#dropped += 1;
      return;
    }
    this.#pending.push(write);
    if (write.decision !== undefined) {
      this.#pendingDecisions.set(write.decision.decisionId, write.decision);
    }
    // While a flush is failing, the backoff timer owns the retry; a full batch must not bypass it.
    this.#schedule(
      this.#pending.length >= FLUSH_MAX_BATCH && this.#retries === 0 ? 0 : FLUSH_DELAY_MS,
    );
  }

  /** Write every queued record now; a failure keeps them queued for the backoff retry. */
  flush(): void {
    this.#cancelTimer();
    while (this.#pending.length > 0 && !this.#closed) {
      if (!this.#flushBatch()) {
        this.#schedule(Math.min(FLUSH_DELAY_MS * 2 ** this.#retries, FLUSH_RETRY_MAX_MS));
        this.#retries += 1;
        return;
      }
      this.#retries = 0;
    }
  }

  findDecision(decisionId: string): ShadowRecord | undefined {
    const queued = this.#pendingDecisions.get(decisionId);
    if (queued !== undefined) {
      return queued;
    }
    const row = this.#statement('SELECT * FROM decision WHERE id = ?').get(decisionId);
    return row === undefined ? undefined : decisionRecord(row);
  }

  read(): LogRecord[] {
    this.flush();
    return this.#readRows(undefined);
  }

  readRecent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    this.flush();
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    return this.#readRows(from);
  }

  /**
   * Stats window as a stream: probe decisions (and, with `scope`, other scopes) are filtered in
   * SQL, and rows are decoded as they are consumed rather than held as arrays. Consume it
   * synchronously: it holds read statements open.
   */
  *iterateRecent(maxAgeDays: number, scope?: Scope, now = Date.now()): Generator<LogRecord> {
    this.flush();
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    const skipped = new Set<string>();
    const filter = scope === undefined ? '' : ' AND scope = ?';
    const decisions = this.#database.prepare(
      `SELECT * FROM decision WHERE ts >= ? AND harness NOT IN ('mcp', 'cli')${filter} ORDER BY ts`,
    );
    for (const row of decisions.iterate(from, ...(scope === undefined ? [] : [scope]))) {
      yield* keepReadable(row, skipped);
    }
    const outcomes = this.#database.prepare('SELECT * FROM outcome WHERE ts >= ? ORDER BY seq');
    for (const row of outcomes.iterate(from)) {
      const record = outcomeRecord(row);
      if (!skipped.has(record.decisionId)) yield record;
    }
    const usage = this.#database.prepare('SELECT * FROM usage WHERE ts >= ? ORDER BY ts, seq');
    for (const row of usage.iterate(from)) {
      const record = usageRecord(row);
      if (!skipped.has(record.decisionId)) yield record;
    }
    reportSkipped(skipped.size);
  }

  /**
   * Startup query for precedent: escalated decisions with verified outcomes and unverified veto
   * candidates; recent keyed auto-allows; and older keyed auto-allows with a veto. Each decision
   * precedes its outcomes in `seq` order so neutral corrections replay consistently.
   */
  readVerifiedPrecedent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    this.flush();
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    const recent = Math.max(from, now - ALLOW_VETO_REPLAY_MS);
    const rows = this.#statement(
      `SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified,
         o.claimed_source AS outcome_claimed_source
       FROM decision d
       LEFT JOIN outcome o
         ON o.decision_id = d.id AND ((o.verified = 1 AND o.source <> 'unverified')
           OR (o.verified = 0 AND o.source = 'unverified'
             AND o.outcome IN ('deny', 'unsafe')))
       WHERE d.action = 'ask' AND d.precedent_key IS NOT NULL AND d.ts >= ?
       UNION ALL
       SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified,
         o.claimed_source AS outcome_claimed_source
       FROM decision d
       LEFT JOIN outcome o
         ON o.decision_id = d.id AND ((o.verified = 1 AND o.source <> 'unverified')
           OR (o.verified = 0 AND o.source = 'unverified'
             AND o.outcome IN ('deny', 'unsafe')))
       WHERE d.action = 'allow' AND d.precedent_key IS NOT NULL AND d.ts >= ?
       UNION ALL
       SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified,
         o.claimed_source AS outcome_claimed_source
       FROM decision d
       JOIN outcome o
         ON o.decision_id = d.id AND ((o.verified = 1 AND o.source <> 'unverified')
           OR (o.verified = 0 AND o.source = 'unverified'
             AND o.outcome IN ('deny', 'unsafe')))
       WHERE d.action = 'allow' AND d.precedent_key IS NOT NULL AND d.ts >= ? AND d.ts < ?
         AND d.id IN (
           SELECT v.decision_id FROM outcome v
           WHERE ((v.verified = 1 AND v.source <> 'unverified'
               AND v.outcome IN ('deny', 'unsafe'))
             OR (v.verified = 0 AND v.source = 'unverified'
               AND v.outcome IN ('deny', 'unsafe'))) AND v.ts >= ?
         )
       ORDER BY ts, id, outcome_seq`,
    ).all(from, recent, from, recent, from);
    return precedentRecords(rows);
  }

  /** Deletes in short transactions with event-loop yields; resolves to the decisions deleted. */
  prune(retainDays: number, now = Date.now()): Promise<number> {
    if (this.#pruning !== undefined) {
      return this.#pruning;
    }
    this.flush();
    const cutoffs = {
      cutoff: utcDateStart(now - retainDays * DAY_MS),
      unverifiedCutoff: utcDateStart(now - Math.min(retainDays, UNVERIFIED_RETAIN_DAYS) * DAY_MS),
    };
    const run = pruneDatabase(this.#database, cutoffs, () => this.#closed).finally(() => {
      this.#pruning = undefined;
    });
    this.#pruning = run;
    return run;
  }

  /** Export records as daily `decisions-YYYY-MM-DD.jsonl` files, the portability format. */
  exportDirectory(destination: string, since?: string): void {
    const records = this.read().filter((record) => since === undefined || record.ts >= since);
    const grouped = new Map<string, string[]>();
    for (const record of records) {
      const date = record.ts.slice(0, 10);
      const lines = grouped.get(date) ?? [];
      lines.push(JSON.stringify(record));
      grouped.set(date, lines);
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [date, lines] of grouped) {
      const output = join(destination, `decisions-${date}.jsonl`);
      writeFileSync(output, `${lines.join('\n')}\n`, { mode: 0o600 });
      chmodSync(output, 0o600);
    }
  }

  /** Copy a consistent snapshot with SQLite's online VACUUM INTO operation. */
  backup(destination: string): void {
    this.flush();
    snapshotTo(this.#database, destination);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.flush();
    this.#closed = true;
    this.#cancelTimer();
    this.#discardPending();
    this.#statements.clear();
    try {
      this.#database.close();
    } finally {
      releaseLock(this.#lock);
    }
  }

  /** Each distinct SQL text is prepared once and reused. */
  #statement(sql: string): Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #readRows(from: number | undefined): LogRecord[] {
    const predicate = from === undefined ? '' : ' WHERE ts >= ?';
    const args = from === undefined ? [] : [from];
    const skipped = new Set<string>();
    const decisions = this.#statement(`SELECT * FROM decision${predicate} ORDER BY ts`)
      .all(...args)
      .flatMap((row) => keepReadable(row, skipped));
    // Stats folds outcomes in record order; seq preserves latest-appended semantics if clocks move.
    const outcomes = this.#statement(`SELECT * FROM outcome${predicate} ORDER BY seq`)
      .all(...args)
      .map(outcomeRecord)
      .filter((record) => !skipped.has(record.decisionId));
    const usage = this.#statement(`SELECT * FROM usage${predicate} ORDER BY ts, seq`)
      .all(...args)
      .map(usageRecord)
      .filter((record) => !skipped.has(record.decisionId));
    reportSkipped(skipped.size);
    return [...decisions, ...outcomes, ...usage];
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== undefined && delayMs > 0) {
      return;
    }
    this.#cancelTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, delayMs);
    this.#timer.unref();
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Write up to one batch in a single transaction; false means it failed and stays queued. */
  #flushBatch(): boolean {
    const batch = this.#pending.slice(0, FLUSH_MAX_BATCH);
    try {
      this.#database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      this.#flushFailed(error);
      return false;
    }
    try {
      for (const write of batch) {
        this.#writeOne(write);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#rollback();
      this.#flushFailed(error);
      return false;
    }
    this.#pending.splice(0, batch.length);
    for (const write of batch) {
      if (write.decision !== undefined) {
        this.#pendingDecisions.delete(write.decision.decisionId);
      }
    }
    this.#reportDrops();
    return true;
  }

  /** A constraint violation is the row's own fault: skip it so it cannot block the queue. */
  #writeOne(write: PendingWrite): void {
    try {
      this.#statement(write.sql).run(...write.params);
    } catch (error) {
      if (!isConstraintError(error)) {
        throw error;
      }
      console.error(`sqlite log: skipped a row (${errorMessage(error)})`);
    }
  }

  #rollback(): void {
    try {
      this.#database.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone; the retry starts with BEGIN again.
    }
  }

  #flushFailed(error: unknown): void {
    const now = Date.now();
    if (
      this.#lastErrorLog !== undefined &&
      now - this.#lastErrorLog < FLUSH_ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.#lastErrorLog = now;
    const dropped = this.#takeDropped();
    console.error(
      `sqlite log: write failed, ${String(this.#pending.length)} records queued for retry: ${errorMessage(error)}${dropped}`,
    );
  }

  #reportDrops(): void {
    const dropped = this.#takeDropped();
    if (dropped !== '') {
      console.error(`sqlite log:${dropped.slice(1)}`);
    }
  }

  #takeDropped(): string {
    const count = this.#dropped;
    this.#dropped = 0;
    return count === 0 ? '' : `; dropped ${String(count)} records over the queue limit`;
  }

  #discardPending(): void {
    if (this.#pending.length > 0) {
      console.error(
        `sqlite log: ${String(this.#pending.length)} unwritten records dropped at close`,
      );
    }
    this.#pending = [];
    this.#pendingDecisions.clear();
  }
}

function bindRecord(record: LogRecord): PendingWrite {
  if (record.kind === 'decision') {
    return { sql: DECISION_SQL, params: decisionParams(record), decision: record };
  }
  return record.kind === 'outcome' ? outcomeWrite(record) : usageWrite(record);
}

const DECISION_SQL = `INSERT INTO decision (
        id, ts, policy, variant, mode, scope, harness, session_id, call_id,
        permission_mode, subagent, input_hash, precedent_key, template_key,
        state_tokens, action, enforced, engine, model, latency_ms, queue_ms,
        engine_ms, error, power, requested_model, routed_model, answers, truncated
      ) VALUES (${Array.from({ length: 28 }, () => '?').join(', ')})`;

function decisionParams(record: ShadowRecord): SqlValue[] {
  const extras = record as ShadowRecord & { readonly templateKey?: string };
  return [
    record.decisionId,
    epoch(record.ts),
    record.policy,
    nullable(record.variant),
    record.mode,
    nullable(record.scope),
    record.harness,
    nullable(record.sessionId),
    nullable(record.callId),
    nullable(record.permissionMode),
    nullableBoolean(record.subagent),
    record.inputHash,
    nullable(record.precedentKey),
    nullable(extras.templateKey),
    nullable(record.stateTokens),
    record.action,
    record.enforced ? 1 : 0,
    record.engine,
    record.model,
    record.latencyMs,
    nullable(record.queueMs),
    nullable(record.engineMs),
    nullable(record.error),
    null,
    nullable(record.requestedModel),
    nullable(record.routedModel),
    JSON.stringify(record.answers),
    record.truncated === undefined ? null : JSON.stringify(record.truncated),
  ];
}

function outcomeWrite(record: OutcomeRecord): PendingWrite {
  return {
    sql: `INSERT INTO outcome (decision_id, ts, outcome, source, verified, claimed_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      record.decisionId,
      epoch(record.ts),
      record.outcome,
      record.source,
      record.verified === true ? 1 : 0,
      nullable(record.claimedSource),
    ],
  };
}

function usageWrite(record: UsageRecord): PendingWrite {
  return {
    sql: `INSERT INTO usage (
        decision_id, ts, turn_id, model, input_tokens, cached_input_tokens,
        output_tokens, cost_usd, verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      record.decisionId,
      epoch(record.ts),
      nullable(record.turnId),
      nullable(record.model),
      record.inputTokens,
      record.cachedInputTokens,
      record.outputTokens,
      nullable(record.costUsd),
      record.verified === true ? 1 : 0,
    ],
  };
}

function isConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return false;
  return typeof error.errcode === 'number' && (error.errcode & 0xff) === SQLITE_CONSTRAINT;
}

/** Open the store under the data directory; writers take the pid lock. */
export function openLogStore(
  paths: Paths,
  options: { readonly readOnly?: boolean } = {},
): SqliteLog {
  const readOnly = options.readOnly === true;
  return SqliteLog.open(join(paths.data, 'decider.db'), {
    readOnly,
    ...(readOnly ? {} : { lockPath: join(paths.run, 'db.lock') }),
  });
}

function openDatabase(Db: DatabaseConstructor, file: string, options: OpenLogOptions): SqliteLog {
  const readOnly = options.readOnly === true;
  let lock: Lock | undefined;
  let database: Database | undefined;
  try {
    if (!readOnly) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(file), 0o700);
      lock = options.lockPath === undefined ? undefined : acquireLock(options.lockPath);
      createPrivateFile(file);
    }
    database = new Db(file, { allowExtension: false, readOnly, timeout: 2000 });
    if (readOnly) {
      checkReaderVersion(database, file);
    } else {
      configureDatabase(database, file);
      chmodSync(file, 0o600);
    }
    return new SqliteLog(database, lock);
  } catch (error) {
    const failure = readOnly ? (missingReadOnlyDatabaseError(file, error) ?? error) : error;
    try {
      database?.close();
    } catch {
      // Preserve the startup failure and still release the process lock.
    }
    releaseLock(lock);
    throw failure;
  }
}

function missingReadOnlyDatabaseError(file: string, cause: unknown): Error | undefined {
  if (errorCode(cause) === 'ENOENT') return missingLogError(file, cause);
  if (!isSqliteCantOpen(cause)) return undefined;
  try {
    lstatSync(file);
    return undefined;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? missingLogError(file, error) : undefined;
  }
}

function isSqliteCantOpen(error: unknown): boolean {
  return (
    error instanceof Error &&
    errorCode(error) === 'ERR_SQLITE_ERROR' &&
    error.message === 'unable to open database file'
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function missingLogError(file: string, cause: unknown): Error & { readonly code: string } {
  return Object.assign(new Error(`SQLite log does not exist: ${file}`, { cause }), {
    code: 'ENOENT',
  });
}

function configureDatabase(database: Database, file: string): void {
  // auto_vacuum only takes effect before the first table exists.
  database.exec('PRAGMA auto_vacuum=INCREMENTAL');
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA busy_timeout=2000');
  migrate(database, file);
  ensureIncrementalVacuum(database);
}

/**
 * `auto_vacuum` only applies to a database created after it was set. A file that already had
 * tables (created elsewhere, or before the pragma) is rebuilt once so pruning can reclaim pages.
 */
function ensureIncrementalVacuum(database: Database): void {
  const mode = Number(database.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum'] ?? 0);
  if (mode === 2) {
    return;
  }
  try {
    database.exec('VACUUM');
  } catch (error) {
    console.error(
      `sqlite log: could not enable incremental vacuum (${errorMessage(error)}); pruning will not reclaim space`,
    );
  }
}

/** Apply pending steps from `PRAGMA user_version`; each step and its version bump is atomic. */
function migrate(database: Database, file: string): void {
  const current = schemaVersion(database);
  if (current > MIGRATIONS.length) {
    throw newerSchemaError(current, file);
  }
  if (current > 0 && current < MIGRATIONS.length) {
    backupBeforeMigrating(database, file, current);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(MIGRATIONS[version] as string);
      database.exec(`PRAGMA user_version = ${String(version + 1)}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function schemaVersion(database: Database): number {
  return Number(database.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
}

function newerSchemaError(current: number, file: string): Error {
  return new Error(
    `SQLite log schema version ${String(current)} is newer than this build supports ` +
      `(${String(MIGRATIONS.length)}): upgrade local-decider or restore a backup (${file})`,
  );
}

/** Read-only opens never migrate, so a mismatched schema would be read silently wrong. */
function checkReaderVersion(database: Database, file: string): void {
  const current = schemaVersion(database);
  if (current > MIGRATIONS.length) {
    throw newerSchemaError(current, file);
  }
  if (current > 0 && current < MIGRATIONS.length) {
    throw new Error(
      `SQLite log schema version ${String(current)} is older than this build ` +
        `(${String(MIGRATIONS.length)}); start the gateway once to migrate (${file})`,
    );
  }
}

/** Newest backups kept per database file. */
const MIGRATION_BACKUPS_KEEP = 3;

/**
 * Snapshot the file before a schema change. A failure only warns: every migration step is one
 * transaction, so a failed step rolls back, and a full disk must not stop decisions.
 */
function backupBeforeMigrating(database: Database, file: string, current: number): void {
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
  const target = `${file}.pre-v${String(current)}-${stamp}.bak`;
  try {
    snapshotTo(database, target);
  } catch (error) {
    console.error(
      `sqlite log: could not back up ${file} before migrating schema v${String(current)} → ` +
        `v${String(MIGRATIONS.length)} (${errorMessage(error)}); migrating anyway`,
    );
    return;
  }
  pruneMigrationBackups(file);
}

function pruneMigrationBackups(file: string): void {
  const prefix = `${basename(file)}.pre-v`;
  try {
    const backups = readdirSync(dirname(file))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .toSorted((a, b) => backupStamp(b, prefix).localeCompare(backupStamp(a, prefix)));
    for (const name of backups.slice(MIGRATION_BACKUPS_KEEP)) {
      unlinkSync(join(dirname(file), name));
    }
  } catch (error) {
    console.error(`sqlite log: could not prune old migration backups (${errorMessage(error)})`);
  }
}

/** The sortable `YYYYMMDDTHHmmss` part of `<file>.pre-v<N>-<stamp>.bak`. */
function backupStamp(name: string, prefix: string): string {
  return name.slice(prefix.length).replace(/^\d+-/, '');
}

/** Copy a consistent snapshot with VACUUM INTO into a private temp dir, then link it into place. */
function snapshotTo(database: Database, destination: string): void {
  const directory = mkdtempSync(join(dirname(destination), `.${basename(destination)}-tmp-`));
  chmodSync(directory, 0o700);
  const temporary = join(directory, 'snapshot.db');
  try {
    const escaped = temporary.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
    chmodSync(temporary, 0o600);
    linkSync(temporary, destination);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Append only: step N takes a database from `user_version` N to N + 1. */
const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE decision(
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, policy TEXT NOT NULL, variant TEXT,
  mode TEXT NOT NULL, scope TEXT, harness TEXT NOT NULL, session_id TEXT, call_id TEXT,
  permission_mode TEXT, subagent INTEGER, input_hash TEXT NOT NULL,
  precedent_key TEXT, template_key TEXT, state_tokens INTEGER,
  action TEXT NOT NULL, enforced INTEGER NOT NULL, engine TEXT, model TEXT,
  latency_ms INTEGER, queue_ms INTEGER, engine_ms INTEGER, error TEXT, power TEXT,
  requested_model TEXT, routed_model TEXT, answers TEXT NOT NULL) STRICT;
CREATE INDEX decision_ts ON decision(ts);
CREATE INDEX decision_policy_ts ON decision(policy, ts);
CREATE INDEX decision_scope_ts ON decision(scope, ts) WHERE scope IS NOT NULL;
CREATE INDEX decision_prec ON decision(precedent_key, ts)
  WHERE action = 'ask' AND precedent_key IS NOT NULL;
CREATE INDEX decision_tmpl ON decision(template_key, ts)
  WHERE action = 'ask' AND template_key IS NOT NULL;
CREATE TABLE outcome(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL,
  outcome TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL) STRICT;
CREATE INDEX outcome_ts ON outcome(ts);
CREATE INDEX outcome_decision ON outcome(decision_id, seq);
CREATE TABLE usage(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL, turn_id TEXT,
  model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL) STRICT;
CREATE INDEX usage_ts ON usage(ts);
CREATE INDEX usage_decision ON usage(decision_id);
`,
  'UPDATE decision SET precedent_key = NULL;',
  'ALTER TABLE outcome ADD COLUMN claimed_source TEXT;',
  'ALTER TABLE decision ADD COLUMN truncated TEXT;',
  // Rows written before report-token gating of usage cannot be told apart: keep them verified.
  'ALTER TABLE usage ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;',
];

function loadDatabase(): DatabaseConstructor {
  const sqlite = process.getBuiltinModule('node:sqlite') as DatabaseModule | undefined;
  const Db = sqlite?.Database ?? sqlite?.DatabaseSync;
  if (Db === undefined) {
    throw new Error(
      'node:sqlite is unavailable in this runtime; local-decider needs Node >= 24.15',
    );
  }
  return Db;
}

function ensureSupportedNode(): void {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(
      `Node ${process.versions.node} is below the SQLite minimum 24.15; local-decider needs Node >= 24.15`,
    );
  }
}

function createPrivateFile(file: string): void {
  const fd = openSync(file, 'a', 0o600);
  closeSync(fd);
  chmodSync(file, 0o600);
}

function acquireLock(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${String(process.pid)}\n`);
        const { dev, ino } = fstatSync(fd);
        return { path, fd, dev, ino };
      } catch (error) {
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
    } catch (error) {
      if (!isExistsError(error) || !removeStaleLock(path)) {
        throw new Error(`SQLite database is locked by another writer (${path})`, { cause: error });
      }
    }
  }
  throw new Error(`SQLite database is locked by another writer (${path})`);
}

function removeStaleLock(path: string): boolean {
  try {
    const beforeStat = lstatSync(path);
    const before = readFileSync(path, 'utf8');
    const pid = Number.parseInt(before, 10);
    if (!Number.isInteger(pid) || processIsAlive(pid)) {
      return false;
    }
    const afterStat = lstatSync(path);
    const after = readFileSync(path, 'utf8');
    if (before !== after || beforeStat.dev !== afterStat.dev || beforeStat.ino !== afterStat.ino) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseLock(lock: Lock | undefined): void {
  if (lock === undefined) {
    return;
  }
  try {
    closeSync(lock.fd);
  } catch {
    // The descriptor may already have been closed during a failed open.
  }
  try {
    const pathStat = lstatSync(lock.path);
    if (pathStat.dev === lock.dev && pathStat.ino === lock.ino) {
      unlinkSync(lock.path);
    }
  } catch {
    // A replaced or removed lock belongs to another process and is left alone.
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function nullable<T extends SqlValue>(value: T | undefined): T | null {
  return value ?? null;
}

function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function epoch(ts: string): number {
  const value = Date.parse(ts);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid log timestamp: ${ts}`);
  }
  return value;
}

function utcDateStart(timeMs: number): number {
  return Date.parse(new Date(timeMs).toISOString().slice(0, 10));
}

function isoTime(value: SqlValue | undefined): string {
  return new Date(Number(value)).toISOString();
}

function text(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: SqlValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

type DecisionExtras = Partial<ShadowRecord> & { readonly templateKey?: string };

/** The decision as a one-element list, or empty (and its id noted) when the row is unreadable. */
function keepReadable(row: Row, skipped: Set<string>): ShadowRecord[] {
  const record = decisionRecord(row);
  if (record === undefined) {
    skipped.add(text(row['id']));
    return [];
  }
  return [record];
}

function reportSkipped(count: number): void {
  if (count > 0) {
    console.error(`sqlite log: skipped ${String(count)} unreadable rows`);
  }
}

function parseAnswers(value: SqlValue | undefined): ShadowRecord['answers'] | undefined {
  try {
    const parsed: unknown = JSON.parse(text(value));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as ShadowRecord['answers'])
      : undefined;
  } catch {
    return undefined;
  }
}

function decisionRecord(row: Row): ShadowRecord | undefined {
  const answers = parseAnswers(row['answers']);
  if (answers === undefined) {
    return undefined;
  }
  return {
    kind: 'decision',
    ts: isoTime(row['ts']),
    decisionId: text(row['id']),
    policy: text(row['policy']),
    mode: text(row['mode']) as ShadowRecord['mode'],
    harness: text(row['harness']) as ShadowRecord['harness'],
    inputHash: text(row['input_hash']),
    answers,
    action: text(row['action']),
    enforced: Number(row['enforced']) === 1,
    engine: text(row['engine']),
    model: text(row['model']),
    latencyMs: Number(row['latency_ms'] ?? 0),
    ...decisionContext(row),
    ...decisionMetrics(row),
  };
}

function decisionContext(row: Row): DecisionExtras {
  const variant = optionalText(row['variant']);
  const scope = optionalText(row['scope']);
  const sessionId = optionalText(row['session_id']);
  const callId = optionalText(row['call_id']);
  const permissionMode = optionalText(row['permission_mode']);
  return {
    ...(variant === undefined ? {} : { variant }),
    ...(scope === undefined ? {} : { scope: scope as NonNullable<ShadowRecord['scope']> }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(callId === undefined ? {} : { callId }),
    ...(permissionMode === undefined
      ? {}
      : { permissionMode: permissionMode as NonNullable<ShadowRecord['permissionMode']> }),
    ...(row['subagent'] === null || row['subagent'] === undefined
      ? {}
      : { subagent: Number(row['subagent']) === 1 }),
  };
}

function decisionMetrics(row: Row): DecisionExtras {
  const precedentKey = optionalText(row['precedent_key']);
  const stateTokens = optionalNumber(row['state_tokens']);
  const error = optionalText(row['error']);
  const requestedModel = optionalText(row['requested_model']);
  const routedModel = optionalText(row['routed_model']);
  const templateKey = optionalText(row['template_key']);
  const queueMs = optionalNumber(row['queue_ms']);
  const engineMs = optionalNumber(row['engine_ms']);
  const truncated = truncatedLabels(row['truncated']);
  return {
    ...(truncated === undefined ? {} : { truncated }),
    ...(precedentKey === undefined ? {} : { precedentKey }),
    ...(stateTokens === undefined ? {} : { stateTokens }),
    ...(error === undefined ? {} : { error }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(routedModel === undefined ? {} : { routedModel }),
    ...(templateKey === undefined ? {} : { templateKey }),
    ...(queueMs === undefined ? {} : { queueMs }),
    ...(engineMs === undefined ? {} : { engineMs }),
  };
}

function truncatedLabels(value: SqlValue | undefined): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((label) => typeof label === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function outcomeRecord(row: Row): OutcomeRecord {
  const claimedSource = optionalText(row['outcome_claimed_source'] ?? row['claimed_source']);
  return {
    kind: 'outcome',
    ts: isoTime(row['outcome_ts'] ?? row['ts']),
    decisionId: text(row['decision_id'] ?? row['id']),
    outcome: text(row['outcome']),
    source: text(row['source']) as OutcomeRecord['source'],
    ...(claimedSource === undefined
      ? {}
      : { claimedSource: claimedSource as OutcomeRecord['source'] }),
    verified: Number(row['verified']) === 1,
  };
}

/** One decision record per decision id, then its outcome rows (rows are grouped by id). */
function precedentRecords(rows: readonly Row[]): LogRecord[] {
  const records: LogRecord[] = [];
  const skipped = new Set<string>();
  let last: string | undefined;
  for (const row of rows) {
    const id = text(row['id']);
    if (id !== last) {
      records.push(...keepReadable(row, skipped));
      last = id;
    }
    if (!skipped.has(id) && row['outcome_seq'] !== null && row['outcome_seq'] !== undefined) {
      records.push(outcomeRecord(row));
    }
  }
  reportSkipped(skipped.size);
  return records;
}

function usageRecord(row: Row): UsageRecord {
  const turnId = optionalText(row['turn_id']);
  const model = optionalText(row['model']);
  const costUsd = optionalNumber(row['cost_usd']);
  return {
    kind: 'usage',
    ts: isoTime(row['ts']),
    decisionId: text(row['decision_id']),
    inputTokens: Number(row['input_tokens']),
    cachedInputTokens: Number(row['cached_input_tokens']),
    outputTokens: Number(row['output_tokens']),
    verified: Number(row['verified']) === 1,
    ...(turnId === undefined ? {} : { turnId }),
    ...(model === undefined ? {} : { model }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
