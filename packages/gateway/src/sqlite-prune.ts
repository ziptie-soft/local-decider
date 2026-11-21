type SqlValue = null | number | bigint | string;

interface PruneStatement {
  run(...values: SqlValue[]): { changes: number | bigint };
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
}

/** The slice of the database a prune needs. */
export interface PruneDatabase {
  exec(sql: string): void;
  prepare(sql: string): PruneStatement;
}

export interface PruneCutoffs {
  /** Decisions older than this (epoch ms) go with their outcomes and usage. */
  readonly cutoff: number;
  /** Unverified outcome and usage rows older than this go whatever the retention. */
  readonly unverifiedCutoff: number;
}

const PRUNE_CHUNK_ROWS = 2000;
const VACUUM_CHUNK_PAGES = 1000;

/**
 * Delete in transactions of at most `PRUNE_CHUNK_ROWS` rows, yielding to the event loop between
 * them so queued appends flush. Children go before their decisions, so a crash leaves orphans
 * (removed by the next sweep) and never a dangling reference. Resolves to the decisions deleted.
 */
export async function pruneDatabase(
  db: PruneDatabase,
  cutoffs: PruneCutoffs,
  isClosed: () => boolean,
): Promise<number> {
  const { cutoff, unverifiedCutoff } = cutoffs;
  for (const table of ['usage', 'outcome']) {
    await drain(
      db,
      isClosed,
      `DELETE FROM ${table} WHERE seq IN (
         SELECT t.seq FROM decision d JOIN ${table} t ON t.decision_id = d.id
         WHERE d.ts < ? LIMIT ?)`,
      [cutoff],
    );
  }
  const deleted = await drain(
    db,
    isClosed,
    'DELETE FROM decision WHERE rowid IN (SELECT rowid FROM decision WHERE ts < ? LIMIT ?)',
    [cutoff],
  );
  await sweep(db, isClosed, 'usage', unverifiedCutoff);
  await sweep(db, isClosed, 'outcome', unverifiedCutoff);
  await vacuum(db, isClosed);
  return deleted;
}

function inTransaction<T>(db: PruneDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original failure.
    }
    throw error;
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Repeat a `LIMIT ?` delete until a chunk comes back short. */
async function drain(
  db: PruneDatabase,
  isClosed: () => boolean,
  sql: string,
  params: SqlValue[],
): Promise<number> {
  if (isClosed()) return 0;
  const statement = db.prepare(sql);
  let total = 0;
  while (!isClosed()) {
    const changes = Number(
      inTransaction(db, () => statement.run(...params, PRUNE_CHUNK_ROWS)).changes,
    );
    total += changes;
    await yieldToLoop();
    if (changes < PRUNE_CHUNK_ROWS) {
      break;
    }
  }
  return total;
}

/**
 * One linear pass over `seq`: rows whose decision is gone, and aged unverified rows, are removed
 * chunk by chunk behind a cursor instead of rescanning the table per chunk.
 */
async function sweep(
  db: PruneDatabase,
  isClosed: () => boolean,
  table: 'usage' | 'outcome',
  unverifiedCutoff: number,
): Promise<void> {
  if (isClosed()) return;
  const upper = db.prepare(
    `SELECT max(seq) AS top FROM (SELECT seq FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?)`,
  );
  const remove = db.prepare(
    `DELETE FROM ${table} WHERE seq > ? AND seq <= ? AND (
       NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = ${table}.decision_id)
       OR (verified = 0 AND ts < ?))`,
  );
  let cursor = 0;
  while (!isClosed()) {
    const top = upper.get(cursor, PRUNE_CHUNK_ROWS)?.['top'];
    if (typeof top !== 'number') {
      return;
    }
    const from = cursor;
    inTransaction(db, () => remove.run(from, top, unverifiedCutoff));
    cursor = top;
    await yieldToLoop();
  }
}

function freelist(statement: PruneStatement): number {
  return Number(statement.get()?.['freelist_count'] ?? 0);
}

/** Reclaim freed pages in chunks; a failure is logged and never fails the prune. */
async function vacuum(db: PruneDatabase, isClosed: () => boolean): Promise<void> {
  if (isClosed()) return;
  try {
    const pages = db.prepare('PRAGMA freelist_count');
    let remaining = freelist(pages);
    while (remaining > 0 && !isClosed()) {
      db.exec(`PRAGMA incremental_vacuum(${String(VACUUM_CHUNK_PAGES)})`);
      const next = freelist(pages);
      if (next >= remaining) {
        return;
      }
      remaining = next;
      await yieldToLoop();
    }
  } catch (error) {
    console.error(`log vacuum failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
