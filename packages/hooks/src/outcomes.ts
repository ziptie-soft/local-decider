/**
 * Claude Code permission outcomes. A `PermissionRequest` the user answers (not our own enforced
 * allow, not auto mode's classifier) leaves a pending entry; the `PostToolUse` of the same session
 * and subject proves the approval and posts outcome `allow`. The gateway stores these as
 * unverified (no report token): counted apart as `unverified` in stats, never in agreement or
 * precedent.
 * Denials are not recorded: `decline`/`interrupted` are neutral for agreement anyway.
 * Every failure is swallowed; nothing here prints to stdout.
 */
import {
  canonicalSubject,
  str,
  type DecideResponse,
  type HookInput,
} from '@ziptie-soft/local-decider-core';

import { gatewayClient, type Env } from './gateway-config.ts';
import type { HookHarness } from './mapping.ts';
import {
  claimPending,
  pendingDir,
  purgeExpired,
  writePending,
  type PendingKey,
} from './pending.ts';

/** Post outcome `allow` (source `user`) for a decision; `false` when the gateway did not take it. */
export type ReportOutcome = (decisionId: string) => Promise<boolean>;

export interface OutcomeDeps {
  /** Pending-entry directory; defaults to `pendingDir(env)`. */
  readonly dir?: string;
  readonly now?: () => number;
  /** The gateway call; defaults to a `GatewayClient` from `env`, built only after a claim. */
  readonly reportOutcome?: ReportOutcome;
}

type Log = (msg: string) => void;

/** One permission prompt's gateway answer and the hook's own output for it. */
export interface PermissionAnswer {
  readonly harness: HookHarness;
  readonly hook: HookInput;
  readonly env: Env;
  readonly res: DecideResponse;
  readonly stdout: string;
  readonly deps: OutcomeDeps | undefined;
  readonly log: Log;
}

function keyOf(hook: HookInput): PendingKey | undefined {
  const session = str(hook['session_id']);
  const tool = str(hook['tool_name']);
  const subject =
    tool === undefined ? undefined : canonicalSubject(tool, hook['tool_input'], str(hook['cwd']));
  return session === undefined || subject === undefined ? undefined : { session, subject };
}

function dirOf(env: Env, deps: OutcomeDeps | undefined): string | undefined {
  return deps?.dir ?? pendingDir(env);
}

function nowOf(deps: OutcomeDeps | undefined): number {
  return (deps?.now ?? Date.now)();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Only a prompt the user answers is ground truth. Another `PermissionRequest` hook may answer it
 * instead, invisibly to us; that approval is then recorded as the user's (hence unverified).
 */
function userAnswers(answer: PermissionAnswer): boolean {
  const enforced: unknown = answer.res.enforced;
  const enforcedAllow = enforced === true && answer.res.action === 'allow';
  return (
    answer.harness === 'claude' &&
    answer.hook['permission_mode'] !== 'auto' &&
    answer.stdout === '' &&
    !enforcedAllow
  );
}

/** After a `PermissionRequest` decision: remember it until its `PostToolUse` (or the TTL). */
export function rememberPermission(answer: PermissionAnswer): void {
  const key = keyOf(answer.hook);
  const dir = dirOf(answer.env, answer.deps);
  if (!userAnswers(answer) || key === undefined || dir === undefined) {
    return;
  }
  try {
    writePending(dir, key, answer.res.decisionId, nowOf(answer.deps));
  } catch (error) {
    answer.log(`outcome: pending write failed: ${errorText(error)}`);
  }
}

function reporterFromEnv(env: Env, timeoutMs: number): ReportOutcome {
  const client = gatewayClient(env, timeoutMs);
  return async (decisionId) => client.reportOutcome(decisionId, 'allow', 'user');
}

/** `PostToolUse`: the tool ran, so a pending prompt for it was approved. Never prints. */
export async function postToolUse(
  harness: HookHarness,
  hook: HookInput,
  env: Env,
  deps: OutcomeDeps | undefined,
  log: Log,
  timeoutMs: number,
): Promise<void> {
  const key = keyOf(hook);
  const dir = dirOf(env, deps);
  if (harness !== 'claude' || key === undefined || dir === undefined) {
    return;
  }
  try {
    const decisionId = claimPending(dir, key, nowOf(deps));
    if (decisionId === undefined) {
      return;
    }
    const report = deps?.reportOutcome ?? reporterFromEnv(env, timeoutMs);
    const ok = await report(decisionId);
    log(`outcome: allow for ${decisionId} ${ok ? 'reported' : 'not taken by the gateway'}`);
  } catch (error) {
    log(`outcome: failed: ${errorText(error)}`);
  }
}

/** `SessionStart`: drop expired entries. Cheap and failure-tolerant. */
export function purgePending(env: Env, deps: OutcomeDeps | undefined, log: Log): void {
  const dir = dirOf(env, deps);
  if (dir === undefined) {
    return;
  }
  try {
    purgeExpired(dir, nowOf(deps));
  } catch (error) {
    log(`outcome: purge failed: ${errorText(error)}`);
  }
}
