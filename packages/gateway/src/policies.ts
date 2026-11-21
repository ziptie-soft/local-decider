import {
  mcpOpen,
  parsePolicyFile,
  PolicyError,
  SCOPES,
  type Mode,
  type Policy,
  type Scope,
} from '@ziptie-soft/local-decider-core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GatewayConfig } from './config.ts';
import type { Paths } from './paths.ts';

/** Default policies: `policies/` next to `dist/` when installed, the repo root in development. */
export function defaultPolicyDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'policies'), join(here, '..', '..', '..', 'policies')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0] ?? 'policies';
}

/** Defaults, configured dirs, then `<config>/policies`, read even when created after start. */
export function policyDirs(config: GatewayConfig, paths: Paths): string[] {
  return [...new Set([defaultPolicyDir(), ...config.policyDirs, join(paths.config, 'policies')])];
}

export interface LoadedPolicy {
  readonly policy: Policy;
  readonly mode: Mode;
  /** `policies.<id>.scopes.<scope>.mode` caps for scoped requests; unset scopes run in shadow. */
  readonly scopes?: Partial<Record<Scope, Mode>>;
  readonly source: string;
}

/**
 * Read and validate one policy file: a valid policy (unique threshold keys included) whose id is
 * its file name without the extension. Throws {@link PolicyError}.
 */
export function loadPolicyFile(file: string): Policy {
  return parsePolicyFile(readFileSync(file, 'utf8'), file);
}

function readDir(dir: string): { file: string; policy: Policy }[] {
  if (!existsSync(dir)) {
    return [];
  }
  const seen = new Map<string, string>();
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .toSorted()
    .map((name) => {
      const file = join(dir, name);
      const policy = loadPolicyFile(file);
      const other = seen.get(policy.id);
      if (other !== undefined) {
        throw new PolicyError(`${file}: policy id "${policy.id}" is also defined by ${other}`);
      }
      seen.set(policy.id, file);
      return { file, policy };
    });
}

/** The `scopes.<scope>.mode` caps configured for a policy. */
export function scopeModes(
  settings: GatewayConfig['policies'][string] | undefined,
): Partial<Record<Scope, Mode>> {
  const out: Partial<Record<Scope, Mode>> = {};
  for (const scope of SCOPES) {
    const mode = settings?.scopes?.[scope]?.mode;
    if (mode !== undefined) {
      out[scope] = mode;
    }
  }
  return out;
}

/** Load defaults then each configured dir; a later policy with the same id replaces earlier. */
export function loadPolicies(
  config: GatewayConfig,
  dirs?: readonly string[],
): Map<string, LoadedPolicy> {
  const out = new Map<string, LoadedPolicy>();
  for (const dir of dirs ?? [defaultPolicyDir(), ...config.policyDirs]) {
    for (const { file, policy } of readDir(dir)) {
      const mode = config.policies[policy.id]?.mode ?? policy.mode;
      out.set(policy.id, {
        policy,
        mode,
        scopes: scopeModes(config.policies[policy.id]),
        source: file,
      });
    }
  }
  return inheritMcp(out);
}

/**
 * A variant that leaves `mcp` unset takes its base policy's value, so a variant of a hook-enforced
 * policy cannot be probed through MCP. A base that is not loaded leaves the variant open.
 */
function inheritMcp(policies: Map<string, LoadedPolicy>): Map<string, LoadedPolicy> {
  for (const [id, loaded] of policies) {
    const { variantOf, mcp } = loaded.policy;
    const base = variantOf === undefined ? undefined : policies.get(variantOf);
    if (base !== undefined && mcp === undefined) {
      policies.set(id, { ...loaded, policy: { ...loaded.policy, mcp: mcpOpen(base.policy) } });
    }
  }
  return policies;
}
