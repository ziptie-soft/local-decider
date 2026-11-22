import { CALL_ID, loopbackUrl } from '@ziptie-soft/local-decider-core';
import { createInterface } from 'node:readline/promises';

import { parseCommandArgs, withReadOnlyStore, type ReviewEnv } from './cli-review.ts';
import { UsageError } from './cli-support.ts';
import { isProbeDecision } from './log-store.ts';
import { ALLOW_VETO_REPLAY_MS } from './outcome-labels.ts';
import { readReportToken } from './report-token.ts';

export interface LabelEnv extends ReviewEnv {
  /** The gateway base URL as the CLI resolves it. */
  readonly url: string;
  /** Ask a yes/no question on the terminal; default reads stdin. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly isTty?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: number;
}

const USAGE = 'usage: local-decider label <decision-id> unsafe [--yes]';
const LABEL_TIMEOUT_MS = 5000;

async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function parseLabelArgs(args: readonly string[]): { id: string; yes: boolean } {
  const { values, positionals } = parseCommandArgs(args, { yes: { type: 'boolean' } });
  const [id, value, ...rest] = positionals;
  if (id === undefined || value === undefined || rest.length > 0) {
    throw new UsageError(USAGE);
  }
  if (value !== 'unsafe') {
    throw new UsageError(
      `label: only "unsafe" can be recorded (a decline needs no label); ${USAGE}`,
    );
  }
  if (!CALL_ID.test(id)) {
    throw new UsageError('label: the id is a decision id (letters, digits, - and _)');
  }
  return { id, yes: values.yes === true };
}

/** What the label will not do, as lines for the user; the decision itself is never shown. */
function warnings(
  decision: { action: string; ts: string; precedentKey?: string },
  now: number,
): string[] {
  const lines: string[] = [];
  if (decision.precedentKey === undefined) {
    lines.push(
      'this decision has no precedent key: the label is recorded but teaches no precedent',
    );
  }
  if (decision.action === 'allow' && now - Date.parse(decision.ts) > ALLOW_VETO_REPLAY_MS) {
    lines.push('this allow is older than 25 hours: it is too old to be replayed as a veto');
  }
  return lines;
}

async function post(env: LabelEnv, id: string, token: string): Promise<void> {
  const res = await (env.fetch ?? fetch)(`${env.url}/v1/outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-local-decider-report': token },
    body: JSON.stringify({ decisionId: id, outcome: 'unsafe', source: 'user' }),
    redirect: 'error',
    signal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`gateway refused the label (HTTP ${String(res.status)})`);
  }
}

/**
 * `local-decider label <id> unsafe [--yes]`: record a verified `unsafe` outcome through the
 * running local gateway. Loopback only; the report token is read from its private file and never
 * printed.
 */
export async function labelCommand(env: LabelEnv): Promise<string> {
  const { id, yes } = parseLabelArgs(env.args);
  if (!loopbackUrl(env.url)) {
    throw new Error('labels need a local gateway: LOCAL_DECIDER_URL must point at this machine');
  }
  const decision = withReadOnlyStore(env.paths, (log) => log?.findDecision(id));
  if (decision === undefined) {
    throw new Error('unknown decision: pruned after logs.retainDays or never recorded');
  }
  if (isProbeDecision(decision)) {
    throw new Error('label: that decision is a probe (mcp or cli), not a real tool call');
  }
  const notes = warnings(decision, env.now ?? Date.now());
  if (!yes) {
    if (env.isTty !== true) {
      throw new UsageError(`label needs --yes when stdin is not a terminal; ${USAGE}`);
    }
    const ask = env.confirm ?? askOnTerminal;
    const sure = await ask(
      [...notes, `mark ${id} (${decision.policy}, ${decision.action}) as unsafe?`].join('\n'),
    );
    if (!sure) {
      return 'not labelled';
    }
  }
  const token = readReportToken(env.paths);
  if (token === undefined) {
    throw new Error('report token missing: start the gateway once so it creates it');
  }
  await post(env, id, token);
  return [...notes, `labelled ${id} unsafe (verified)`].join('\n');
}
