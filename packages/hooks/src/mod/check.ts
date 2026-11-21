/**
 * The mod's pure decisions: when a plain `ask` may be upgraded, which calls the local decider
 * never gets to allow, and how a refused call reads. No I/O, no `node:` imports.
 */
import { asRecord, type DecideResponse } from '@ziptie-soft/local-decider-core';

import type { ToolCallResult, ToolCheckEvent, ToolCheckResult } from './types.ts';

/** First Claude Code release whose mod API has what this mod relies on (`agentId`, `ceiling`). */
const MIN_VERSION = '2.1.304';

const CALL_ID = /^[\w-]{1,128}$/;

/** Numeric compare of dotted versions (`2.1.319` ≥ `2.1.304`); anything unparsable is too old. */
export function versionAtLeast(version: unknown, min: string = MIN_VERSION): boolean {
  const base =
    typeof version === 'object' && version !== null ? asRecord(version)?.['base'] : version;
  if (typeof base !== 'string' || !/^\d+(?:\.\d+)*$/.test(base)) {
    return false;
  }
  const have = base.split('.').map(Number);
  const want = min.split('.').map(Number);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return true;
}

/**
 * An `ask` that nothing but the default permission flow produced: not an ask rule, a PreToolUse
 * hook, a setting, a host asker or a ceiling, and from the engine itself, not another mod.
 */
export function isPlainAsk(
  e: ToolCheckEvent,
  decided: ToolCheckResult,
  origin: { readonly plugin?: string } | undefined,
): boolean {
  return (
    decided.decision === 'ask' &&
    decided.rule === undefined &&
    decided.hook === undefined &&
    decided.setting === undefined &&
    decided.decider === undefined &&
    decided.ceiling === undefined &&
    e.ceiling !== 'ask' &&
    typeof e.tool_use_id === 'string' &&
    CALL_ID.test(e.tool_use_id) &&
    origin?.plugin === 'engine'
  );
}

/** The gateway's `GET /v1/calls/:id` body, as far as the mod reads it. */
export interface CallInfo {
  readonly permissionMode?: string;
  readonly decisions?: Readonly<
    Record<string, { readonly action?: string; readonly answered?: boolean } | undefined>
  >;
  readonly scopes?: Readonly<Record<string, string | undefined>>;
}

/**
 * Auto mode only (a mod allow would also run commands in `dontAsk` mode) and only when the
 * command-risk policy answered and found nothing to flag. A missing record never allows.
 */
export function callAllows(call: CallInfo | null): boolean {
  if (call?.permissionMode !== 'auto') {
    return false;
  }
  const risk = call.decisions?.['command-risk'];
  return risk?.answered === true && risk.action === 'log';
}

/** Whether this call may be allowed (not just shadowed): act mode for the scope, no subagent. */
export function mayAct(call: CallInfo, e: ToolCheckEvent): boolean {
  return call.scopes?.['claude-auto'] === 'act' && e.agentId === undefined;
}

export function reasonOf(res: Pick<DecideResponse, 'policy' | 'decisionId'>): string {
  return `local-decider ${res.policy} allowed this (decision ${res.decisionId})`;
}

/** Text starts of the refusal that the auto mode classifier itself issued. */
export const CLASSIFIER_DENIAL_PREFIXES: readonly string[] = [
  'Permission for this action was denied by the Claude Code auto mode classifier',
];

/**
 * Refusals that say nothing about the classifier's verdict: its fallback, plain permission asks,
 * and the classifier giving no verdict (a PreToolUse hook rewrote the input after its review).
 */
export const UNDECIDED_PREFIXES: readonly string[] = [
  'This command requires approval',
  'Claude requested permissions to use',
  'Permission to use',
  'The server-side auto mode classifier gave no verdict',
];

/** Phrases that mark an undecided refusal wherever they sit in the first part of the text. */
const UNDECIDED_PHRASES: readonly string[] = [
  "you haven't granted it yet",
  'classifier gave no verdict',
];

const PHRASE_WINDOW = 300;

function refusalText(result: ToolCallResult): string | undefined {
  const text = typeof result.text === 'string' ? result.text : result.result;
  return typeof text === 'string' ? text.replace(/^Error:\s*/, '') : undefined;
}

/**
 * What the auto mode classifier decided about a call, from the result of `tool.call`:
 * `deny` for its denial text, `null` when the permission outcome is unknown (its fallback prompt,
 * any other permission refusal), else `allow` (the tool ran, even if it then failed).
 */
export function classifierVerdict(result: unknown): 'allow' | 'deny' | null {
  const fields = asRecord(result);
  if (fields === undefined) {
    return null;
  }
  if (fields['isError'] !== true) {
    return 'allow';
  }
  const text = refusalText(fields) ?? '';
  if (CLASSIFIER_DENIAL_PREFIXES.some((p) => text.startsWith(p))) {
    return 'deny';
  }
  const head = text.slice(0, PHRASE_WINDOW);
  const undecided =
    UNDECIDED_PREFIXES.some((p) => text.startsWith(p)) ||
    UNDECIDED_PHRASES.some((p) => head.includes(p));
  return undecided ? null : 'allow';
}
