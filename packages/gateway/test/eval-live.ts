import { FACT_GROUPS, type FactGroup } from '@ziptie-soft/local-decider-core';
/**
 * Replay `policies/fixtures/*.jsonl` against a live `/v1/systemone` server and score them.
 *
 *   LOCAL_DECIDER_EVAL_URL=http://127.0.0.1:PORT node --conditions=source test/eval-live.ts \
 *     [--policy <id>] [--record] [--force] [--model <name>] [--out <dir>] [--facts <groups>]
 *
 * `--record` also writes `policies/fixtures/recorded/<policy>.json`, which the CI gate replays. It
 * refuses a model other than the pinned reference unless `--force` is given.
 *
 * `--out <dir>` writes `<policy>.json` (a recording) and `<policy>.results.json` (`EvalResult[]`)
 * there instead of to `policies/fixtures/recorded/`, for `eval-compare.ts`. `--facts <groups>` (a
 * comma-separated list) selects the fact groups the gateway derives (they reach the model only through a
 * policy `facts` section); it cannot be combined with `--record`, so only the shipped set is recorded.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

import { getHealth } from '../src/engines/http.ts';
import { SystemOneRemoteEngine } from '../src/engines/remote.ts';
import { formatEvalSummary, scoreEval, type EvalResult } from '../src/eval.ts';
import { RecordingEngine, serializeRecording, type Recording } from './eval-engines.ts';
import {
  EVAL_REFERENCE,
  FIXTURES_DIR,
  RECORDED_DIR,
  evalFixture,
  floorsFor,
  isReferenceModel,
} from './eval-harness.ts';

interface Target {
  readonly url: string;
  readonly engine: string;
  readonly model: string;
  readonly device: string | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function resolveTarget(modelFlag: string | undefined): Promise<Target> {
  const url = process.env['LOCAL_DECIDER_EVAL_URL'];
  if (url === undefined || url === '') {
    throw new Error('set LOCAL_DECIDER_EVAL_URL to the base URL of a /v1/systemone server');
  }
  const health =
    (await getHealth(url, 5000, '/v1/health')) ?? (await getHealth(url, 5000, '/health'));
  // strands-decider serve reports the repo id as `checkpoint` and a short name as `model`.
  const model = modelFlag ?? text(health?.['checkpoint']) ?? text(health?.['model']);
  if (model === undefined) {
    throw new Error(`no model in ${url}/v1/health or /health; pass --model <name>`);
  }
  return {
    url,
    engine: text(health?.['engine']) ?? EVAL_REFERENCE.engine,
    model,
    device: text(health?.['device']) ?? text(health?.['resolvedDevice']),
  };
}

function fixturePolicies(only: string | undefined): string[] {
  const all = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => basename(name, '.jsonl'))
    .toSorted();
  const chosen = only === undefined ? all : all.filter((id) => id === only);
  if (chosen.length === 0) {
    throw new Error(`no fixture for policy ${only ?? '(any)'}`);
  }
  return chosen;
}

function isFactGroup(group: string): group is FactGroup {
  return (FACT_GROUPS as readonly string[]).includes(group);
}

/** Parse a comma-separated `--facts` list; unknown groups are a usage error. */
function parseFacts(value: string | undefined): readonly FactGroup[] {
  const groups = (value ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group !== '');
  const unknown = groups.filter((group) => !isFactGroup(group));
  if (unknown.length > 0) {
    throw new Error(`unknown --facts group(s): ${unknown.join(', ')} (${FACT_GROUPS.join(', ')})`);
  }
  return groups.filter(isFactGroup);
}

interface RunOptions {
  readonly record: boolean;
  readonly outDir: string | undefined;
  readonly facts: readonly FactGroup[];
}

async function runPolicy(policyId: string, target: Target, options: RunOptions): Promise<boolean> {
  const remote = new SystemOneRemoteEngine({
    type: 'systemone-remote',
    url: target.url,
    model: target.model,
  });
  await remote.start();
  const recorder = new RecordingEngine(remote);
  console.log(`\n== ${policyId}`);
  const results = await evalFixture(policyId, recorder, {
    facts: options.facts,
    report: (line) => console.log(line),
    onCase: (id) => {
      recorder.label = id;
    },
  });
  const summary = scoreEval(results, floorsFor(policyId));
  console.log(formatEvalSummary(summary));
  if (options.record || options.outDir !== undefined) {
    writeRecording(policyId, target, recorder, options.outDir ?? RECORDED_DIR);
  }
  if (options.outDir !== undefined) {
    writeResults(options.outDir, policyId, results);
  }
  return summary.passed;
}

function writeResults(dir: string, policyId: string, results: readonly EvalResult[]): void {
  writeFileSync(join(dir, `${policyId}.results.json`), `${JSON.stringify(results, null, 2)}\n`);
}

function writeRecording(
  policyId: string,
  target: Target,
  recorder: RecordingEngine,
  dir: string,
): void {
  const recording: Recording = {
    version: 1,
    engine: target.engine,
    model: target.model,
    ...(target.device === undefined ? {} : { device: target.device }),
    recordedAt: new Date().toISOString().slice(0, 10),
    cases: Object.fromEntries(recorder.cases),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${policyId}.json`), serializeRecording(recording));
  console.log(`recorded ${String(recorder.cases.size)} cases for ${policyId}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      policy: { type: 'string' },
      record: { type: 'boolean' },
      force: { type: 'boolean' },
      model: { type: 'string' },
      out: { type: 'string' },
      facts: { type: 'string' },
    },
  });
  const facts = parseFacts(values.facts);
  const target = await resolveTarget(values.model);
  const record = values.record === true;
  if (record && values.facts !== undefined) {
    throw new Error('--facts cannot be combined with --record: only the shipped set is recorded');
  }
  const options: RunOptions = {
    // With --out, the recording goes to the directory rather than the repo.
    record: record && values.out === undefined,
    outDir: values.out,
    facts,
  };
  if (record && values.force !== true && !isReferenceModel(target.model)) {
    throw new Error(
      `refusing to record with ${target.model}: the reference is ${EVAL_REFERENCE.model} (use --force)`,
    );
  }
  console.log(`engine ${target.engine} model ${target.model} at ${target.url}`);
  if (facts.length > 0) {
    console.log(`facts ${facts.join(',')}`);
  }
  let ok = true;
  for (const policyId of fixturePolicies(values.policy)) {
    ok = (await runPolicy(policyId, target, options)) && ok;
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
