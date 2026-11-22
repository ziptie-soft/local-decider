import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.ts';
import type { Policy } from './policy.ts';

/** Stable SHA-256 of a JSON-like value: the shadow log's input hash and the cache key. */
export function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * 16 hex chars identifying the rules that decide an action: the policy version, its rules (with
 * any threshold overrides applied) and its default. Explain compares it with the current policy
 * to say whether the rule index of an old decision still means the same rule.
 */
export function rulesHash(policy: Pick<Policy, 'version' | 'rules' | 'default'>): string {
  const { version, rules, default: fallback } = policy;
  return inputHash({ version, rules, default: fallback }).slice(0, 16);
}
