/**
 * Replay `policies/fixtures/*.jsonl` against a live `/v1/systemone` server and score them.
 *
 *   LOCAL_DECIDER_EVAL_URL=http://127.0.0.1:PORT node --conditions=source test/eval-live.ts \
 *     [--policy <id>] [--record] [--force] [--model <name>]
 *
 * `--record` also writes `policies/fixtures/recorded/<policy>.json`, which the CI gate replays. It
 * refuses a model other than the pinned reference unless `--force` is given.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

import { getHealth } from '../src/engines/http.ts';
import { SystemOneRemoteEngine } from '../src/engines/remote.ts';
import { formatEvalSummary, scoreEval } from '../src/eval.ts';
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

async function runPolicy(policyId: string, target: Target, record: boolean): Promise<boolean> {
  const remote = new SystemOneRemoteEngine({
    type: 'systemone-remote',
    url: target.url,
    model: target.model,
  });
  await remote.start();
  const recorder = new RecordingEngine(remote);
  console.log(`\n== ${policyId}`);
  const results = await evalFixture(policyId, recorder, {
    report: (line) => console.log(line),
    onCase: (id) => {
      recorder.label = id;
    },
  });
  const summary = scoreEval(results, floorsFor(policyId));
  console.log(formatEvalSummary(summary));
  if (record) {
    writeRecording(policyId, target, recorder);
  }
  return summary.passed;
}

function writeRecording(policyId: string, target: Target, recorder: RecordingEngine): void {
  const recording: Recording = {
    version: 1,
    engine: target.engine,
    model: target.model,
    ...(target.device === undefined ? {} : { device: target.device }),
    recordedAt: new Date().toISOString().slice(0, 10),
    cases: Object.fromEntries(recorder.cases),
  };
  mkdirSync(RECORDED_DIR, { recursive: true });
  writeFileSync(join(RECORDED_DIR, `${policyId}.json`), serializeRecording(recording));
  console.log(`recorded ${String(recorder.cases.size)} cases for ${policyId}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      policy: { type: 'string' },
      record: { type: 'boolean' },
      force: { type: 'boolean' },
      model: { type: 'string' },
    },
  });
  const target = await resolveTarget(values.model);
  const record = values.record === true;
  if (record && values.force !== true && !isReferenceModel(target.model)) {
    throw new Error(
      `refusing to record with ${target.model}: the reference is ${EVAL_REFERENCE.model} (use --force)`,
    );
  }
  console.log(`engine ${target.engine} model ${target.model} at ${target.url}`);
  let ok = true;
  for (const policyId of fixturePolicies(values.policy)) {
    ok = (await runPolicy(policyId, target, record)) && ok;
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
