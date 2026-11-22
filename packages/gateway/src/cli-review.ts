import { CALL_ID } from '@ziptie-soft/local-decider-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { UsageError } from './cli-support.ts';
import type { GatewayConfig } from './config.ts';
import { explainDecision, formatExplain, type ExplainContext } from './explain.ts';
import type { LogStore } from './log-store.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs } from './policies.ts';
import { openLogStore } from './sqlite-log.ts';

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
