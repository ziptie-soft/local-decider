import { CALL_ID, SCOPES, type Scope } from '@ziptie-soft/local-decider-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { UsageError } from './cli-support.ts';
import type { GatewayConfig } from './config.ts';
import { explainDecision, formatExplain, type ExplainContext } from './explain.ts';
import type { LogStore } from './log-store.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs } from './policies.ts';
import { computeReview, formatReview } from './review.ts';
import { openLogStore } from './sqlite-log.ts';
import { parseDays } from './stats-job.ts';

export interface ReviewEnv {
  readonly paths: Paths;
  readonly config: GatewayConfig;
  readonly args: readonly string[];
}

/** `parseArgs` that reports a bad flag or a missing value as a usage error (exit 2). */
function parseCommandArgs<const T extends ParseArgsOptionsConfig>(
  args: readonly string[],
  options: T,
): ReturnType<typeof parseArgs<{ args: string[]; options: T; allowPositionals: true }>> {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Read the store without migrating or writing it; a fresh install has no database file yet and
 * reads as an empty store (`undefined`).
 */
function withReadOnlyStore<T>(paths: Paths, use: (log: LogStore | undefined) => T): T {
  if (!existsSync(join(paths.data, 'decider.db'))) {
    return use(undefined);
  }
  const log = openLogStore(paths, { readOnly: true });
  try {
    return use(log);
  } finally {
    log.close();
  }
}

/** The policies in force and the `config.yaml` threshold overrides, as the gateway applies them. */
function explainContext(env: Pick<ReviewEnv, 'paths' | 'config'>): ExplainContext {
  const { paths, config } = env;
  return {
    policies: loadPolicies(config, policyDirs(config, paths)),
    overrides: Object.fromEntries(
      Object.entries(config.policies).map(([id, settings]) => [id, settings.thresholds]),
    ),
  };
}

const UNKNOWN =
  'unknown decision: pruned after logs.retainDays or never recorded (explain takes a decision id from a reason text, or a call id)';

function parseExplainArgs(args: readonly string[]): { id: string; json: boolean } {
  const { values, positionals } = parseCommandArgs(args, { json: { type: 'boolean' } });
  const [id, ...rest] = positionals;
  if (id === undefined || rest.length > 0) {
    throw new UsageError('explain takes one decision id: local-decider explain <id> [--json]');
  }
  if (!CALL_ID.test(id)) {
    throw new UsageError(
      'explain: the id is a decision id or a call id (letters, digits, - and _)',
    );
  }
  return { id, json: values.json === true };
}

/** The decision with this id, else the decisions of the call with it; the latter reads as a list. */
function lookup(
  log: LogStore,
  id: string,
): { records: ReturnType<LogStore['findByCall']>; byCall: boolean } {
  const direct = log.findDecision(id);
  if (direct !== undefined) {
    return { records: [direct], byCall: false };
  }
  return { records: log.findByCall(id), byCall: true };
}

/** `local-decider explain <id> [--json]`: read-only, so it works with the gateway down. */
export function explainCommand(env: ReviewEnv): string {
  const { id, json } = parseExplainArgs(env.args);
  const context = explainContext(env);
  const found = withReadOnlyStore(env.paths, (log) => {
    if (log === undefined) {
      return undefined;
    }
    const { records, byCall } = lookup(log, id);
    const views = records.map((record) =>
      explainDecision(
        record,
        log.findOutcomes(record.decisionId),
        log.findUsage(record.decisionId),
        context,
      ),
    );
    return { views, byCall };
  });
  if (found === undefined || found.views.length === 0) {
    throw new Error(UNKNOWN);
  }
  if (json) {
    const body = found.byCall ? found.views : found.views[0];
    return JSON.stringify(body, null, 2);
  }
  return found.views.map(formatExplain).join('\n\n');
}

const DEFAULT_REVIEW_LIMIT = 50;
const MAX_REVIEW_LIMIT = 1000;

interface ReviewArgs {
  readonly days: number;
  readonly policy: string | undefined;
  readonly scope: Scope | undefined;
  readonly limit: number;
  readonly verified: boolean;
  readonly json: boolean;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_REVIEW_LIMIT;
  }
  const limit = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_REVIEW_LIMIT)) {
    throw new UsageError(`review: --limit is an integer from 1 to ${String(MAX_REVIEW_LIMIT)}`);
  }
  return limit;
}

function parseReviewArgs(env: ReviewEnv, policyIds: ReadonlySet<string>): ReviewArgs {
  const { values, positionals } = parseCommandArgs(env.args, {
    json: { type: 'boolean' },
    verified: { type: 'boolean' },
    days: { type: 'string' },
    policy: { type: 'string' },
    scope: { type: 'string' },
    limit: { type: 'string' },
  });
  if (positionals.length > 0) {
    throw new UsageError(
      'review takes no arguments: local-decider review [--days N] [--policy ID] [--scope S] [--limit N] [--verified] [--json]',
    );
  }
  const window = parseDays(values.days, env.config.logs.retainDays);
  if ('error' in window) {
    throw new UsageError(`review: ${window.error}`);
  }
  if (values.scope !== undefined && !(SCOPES as readonly string[]).includes(values.scope)) {
    throw new UsageError(`review: scope must be one of ${SCOPES.join(', ')}`);
  }
  if (values.policy !== undefined && !policyIds.has(values.policy)) {
    throw new UsageError(`review: unknown policy ${values.policy}`);
  }
  return {
    days: window.days,
    policy: values.policy,
    scope: values.scope as Scope | undefined,
    limit: parseLimit(values.limit),
    verified: values.verified === true,
    json: values.json === true,
  };
}

/** `local-decider review`: decisions the user's labels or the classifier contradict; read-only. */
export function reviewCommand(env: ReviewEnv): string {
  const policies = loadPolicies(env.config, policyDirs(env.config, env.paths));
  const args = parseReviewArgs(env, new Set(policies.keys()));
  const records = withReadOnlyStore(env.paths, (log) => [
    ...(log?.iterateRecent(args.days, args.scope) ?? []),
  ]);
  const result = computeReview(records, policies, {
    days: args.days,
    policy: args.policy,
    scope: args.scope,
    limit: args.limit,
    verifiedOnly: args.verified,
  });
  return args.json ? JSON.stringify(result, null, 2) : formatReview(result);
}
