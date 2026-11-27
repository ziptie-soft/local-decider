import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { processStartToken } from './process-start.ts';

export interface OwnerLock {
  readonly path: string;
  readonly nonce: string;
}

export interface OwnerLockDeps {
  readonly pid?: number;
  readonly startToken?: (pid: number) => string | undefined;
  readonly isAlive?: (pid: number) => boolean;
  readonly beforeTakeover?: () => void;
}

export class OwnerLockBusyError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`SQLite database is locked by another writer (${path})`, { cause });
    this.name = 'OwnerLockBusyError';
  }
}

interface OwnerRecord {
  readonly pid: number;
  readonly start: string | null;
  readonly nonce: string;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function recordText(owner: OwnerRecord): string {
  return `${JSON.stringify(owner)}\n`;
}

function legacyRecord(text: string): OwnerRecord | undefined {
  const [pidText, start] = text.split('\n');
  const pid = Number.parseInt(pidText ?? '', 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, start: start || null, nonce: `legacy:${String(pid)}:${start ?? ''}` };
}

function numericLegacyRecord(value: number, text: string): OwnerRecord | undefined {
  if (!Number.isSafeInteger(value) || value <= 0 || !/^\d+\s*$/.test(text)) return undefined;
  return { pid: value, start: null, nonce: `legacy:${String(value)}:` };
}

function isOwnerRow(row: Record<string, unknown>): boolean {
  const validPid = Number.isSafeInteger(row['pid']) && (row['pid'] as number) > 0;
  const validNonce = typeof row['nonce'] === 'string' && row['nonce'] !== '';
  const validStart =
    row['start'] === undefined || row['start'] === null || typeof row['start'] === 'string';
  return validPid && validNonce && validStart;
}

function objectRecord(value: object): OwnerRecord | undefined {
  const row = value as Record<string, unknown>;
  if (!isOwnerRow(row)) return undefined;
  return {
    pid: row['pid'] as number,
    start: typeof row['start'] === 'string' ? row['start'] : null,
    nonce: row['nonce'] as string,
  };
}

function parseRecordValue(value: unknown, text: string): OwnerRecord | undefined {
  if (typeof value === 'number') return numericLegacyRecord(value, text);
  if (typeof value !== 'object' || value === null) return undefined;
  return objectRecord(value);
}

function parseRecord(text: string): OwnerRecord | undefined {
  try {
    return parseRecordValue(JSON.parse(text), text);
  } catch {
    // Keep locks created by older releases live until their process exits.
    return legacyRecord(text);
  }
}

function newOwner(deps: OwnerLockDeps): OwnerRecord {
  const pid = deps.pid ?? process.pid;
  return {
    pid,
    start: (deps.startToken ?? processStartToken)(pid) ?? null,
    nonce: randomBytes(16).toString('hex'),
  };
}

function writeUnique(path: string, content: string): string {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
  return temp;
}

function isOwnerLive(owner: OwnerRecord, deps: OwnerLockDeps): boolean {
  if (!(deps.isAlive ?? pidAlive)(owner.pid)) return false;
  if (owner.start === null) return true;
  const current = (deps.startToken ?? processStartToken)(owner.pid);
  return current === undefined || current === owner.start;
}

function readOwnerText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readOwner(path: string): OwnerRecord | undefined {
  const text = readOwnerText(path);
  return text === undefined ? undefined : parseRecord(text);
}

function takeStale(path: string, staleText: string | undefined, deps: OwnerLockDeps): boolean {
  if (staleText === undefined) return false;
  const stale = parseRecord(staleText);
  if (stale !== undefined && isOwnerLive(stale, deps)) return false;
  deps.beforeTakeover?.();
  const moved = `${path}.${randomBytes(12).toString('hex')}.stale`;
  try {
    renameSync(path, moved);
  } catch {
    return false;
  }
  if (readOwnerText(moved) === staleText) {
    unlinkSync(moved);
    return true;
  }
  let restored = false;
  try {
    linkSync(moved, path);
    restored = true;
  } catch {
    // A newly acquired canonical lock wins; leave the displaced record in place.
  }
  if (restored) {
    try {
      unlinkSync(moved);
    } catch {
      // The restored canonical hard link remains valid.
    }
  }
  return false;
}

/** Acquire a lock with an atomic hard-link publication; readers never see a partial record. */
export function acquireOwnerLock(path: string, deps: OwnerLockDeps = {}): OwnerLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = newOwner(deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temp = writeUnique(path, recordText(owner));
    try {
      linkSync(temp, path);
      return { path, nonce: owner.nonce };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!takeStale(path, readOwnerText(path), deps)) {
        throw new OwnerLockBusyError(path, error);
      }
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // The canonical hard link is independent of this temporary name.
      }
    }
  }
  throw new OwnerLockBusyError(path);
}

/** Remove the canonical lock only when its nonce still identifies this acquisition. */
export function releaseOwnerLock(lock: OwnerLock | undefined): void {
  if (lock === undefined) return;
  const moved = `${lock.path}.${randomBytes(12).toString('hex')}.release`;
  try {
    renameSync(lock.path, moved);
  } catch {
    return;
  }
  if (readOwner(moved)?.nonce === lock.nonce) {
    try {
      unlinkSync(moved);
    } catch {
      // Already removed during shutdown.
    }
    return;
  }
  let restored = false;
  try {
    linkSync(moved, lock.path);
    restored = true;
  } catch {
    // A newer canonical lock wins; keep the moved foreign record intact.
  }
  if (restored) {
    try {
      unlinkSync(moved);
    } catch {
      // The restored canonical hard link remains valid.
    }
  }
}

/** Read and validate a lock record for pidfile and diagnostic callers. */
export function readOwnerLock(path: string): Readonly<OwnerRecord> | undefined {
  return readOwner(path);
}
