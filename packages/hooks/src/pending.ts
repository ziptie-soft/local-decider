/**
 * Pending permission prompts, waiting for the tool call that proves the user approved them.
 *
 * Claude Code's `PermissionRequest` carries no `tool_use_id`, so a prompt is matched to the
 * following `PostToolUse` by session and precedent subject. Each entry is one file named from
 * hashes of both (never the raw values) holding only `{"v":1,"decisionId":"…"}`: no tool input.
 * A new prompt for the same key replaces older entries and a claim takes the newest, so a later
 * approval never reports an earlier denied prompt; the short TTL bounds the rest. Claiming an entry is an `unlink`, so of two
 * concurrent claimers exactly one wins. Entries older than `PENDING_TTL_MS` are deleted unposted.
 */
import { randomBytes, createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Env } from './gateway-config.ts';

/** A `PostToolUse` follows an approved prompt within the user's think time. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** What a pending entry is matched on. Only hashes of these reach the file system. */
export interface PendingKey {
  readonly session: string;
  readonly subject: string;
}

const NAME = /^\.?([0-9a-f]{16})-([0-9a-f]{24})-(\d{1,16})-([0-9a-f]{8})\.json(?:\.tmp)?$/;
const DECISION_ID = /^[\w.:-]{1,128}$/;

/**
 * `<data>/hooks/pending`, with `<data>` resolved exactly like `resolvePaths` in
 * `packages/gateway/src/paths.ts`: `LOCAL_DECIDER_HOME`, else `$XDG_DATA_HOME/local-decider`, else
 * `~/.local/share/local-decider`. As there, a set-but-empty variable still counts (`??`), so the
 * hooks and the gateway agree on the directory; `HOME`/`USERPROFILE` stand in for `os.homedir()`,
 * which also returns an empty `HOME` as is. `undefined` when neither is set.
 */
export function pendingDir(env: Env): string | undefined {
  const home = env['HOME'] ?? env['USERPROFILE'];
  const xdg =
    env['XDG_DATA_HOME'] ?? (home === undefined ? undefined : join(home, '.local', 'share'));
  const data =
    env['LOCAL_DECIDER_HOME'] ?? (xdg === undefined ? undefined : join(xdg, 'local-decider'));
  return data === undefined ? undefined : join(data, 'hooks', 'pending');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function prefixOf(key: PendingKey): string {
  return `${sha256(key.session).slice(0, 16)}-${sha256(`${key.session}\0${key.subject}`).slice(0, 24)}-`;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** Remove a file; `false` when it was already gone (another process claimed or purged it). */
function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function stampOf(name: string): number | undefined {
  const match = NAME.exec(name);
  return match === null ? undefined : Number(match[3]);
}

/** Delete entries (and stray temp files) older than the TTL, without posting anything. */
export function purgeExpired(dir: string, now: number): void {
  for (const name of listing(dir)) {
    const stamp = stampOf(name);
    if (stamp !== undefined && now - stamp > PENDING_TTL_MS) {
      remove(join(dir, name));
    }
  }
}

/** Record a prompt the user is about to answer. Dir 0700, file 0600, written atomically. */
export function writePending(dir: string, key: PendingKey, decisionId: string, now: number): void {
  if (!DECISION_ID.test(decisionId)) {
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  purgeExpired(dir, now);
  for (const old of entriesFor(dir, key)) {
    remove(join(dir, old));
  }
  const name = `${prefixOf(key)}${String(now)}-${randomBytes(4).toString('hex')}.json`;
  const temp = join(dir, `.${name}.tmp`);
  writeFileSync(temp, JSON.stringify({ v: 1, decisionId }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(dir, name));
}

function decisionIdIn(path: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const id = (value as { v?: unknown; decisionId?: unknown } | null)?.decisionId;
    return typeof id === 'string' && DECISION_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Committed entries for `key` (temp files excluded), any age. */
function entriesFor(dir: string, key: PendingKey): string[] {
  const prefix = prefixOf(key);
  return listing(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
}

/** Matching live entries for `key`, newest first. */
function candidates(dir: string, key: PendingKey, now: number): string[] {
  return entriesFor(dir, key)
    .map((name) => ({ name, stamp: stampOf(name) }))
    .filter((e): e is { name: string; stamp: number } => e.stamp !== undefined)
    .filter((e) => now - e.stamp <= PENDING_TTL_MS)
    .toSorted((a, b) => b.stamp - a.stamp || b.name.localeCompare(a.name))
    .map((e) => e.name);
}

/**
 * Take the newest live entry for `key` and return its decision id; `undefined` when there is none
 * or every candidate was taken by another process first.
 */
export function claimPending(dir: string, key: PendingKey, now: number): string | undefined {
  for (const name of candidates(dir, key, now)) {
    const path = join(dir, name);
    const id = decisionIdIn(path);
    if (remove(path) && id !== undefined) {
      return id;
    }
  }
  return undefined;
}
