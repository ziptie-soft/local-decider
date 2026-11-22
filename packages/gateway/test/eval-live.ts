import { FACT_GROUPS, type FactGroup } from '@ziptie-soft/local-decider-core';
/**
 * Replay `policies/fixtures/*.jsonl` against a live `/v1/systemone` server and score them.
 *
 *   LOCAL_DECIDER_EVAL_URL=http://127.0.0.1:PORT node --conditions=source test/eval-live.ts \
 *     [--policy <id>] [--record] [--replay] [--fixtures <dir>] [--force] [--model <name>] [--out <dir>] [--facts <groups>]
 *
 * `--replay` answers from `policies/fixtures/recorded/` instead of a server (seconds, no engine;
 * a case with no recording is `unavailable`), for rule, threshold and default candidates.
 * `--fixtures <dir>` scores another fixture directory (a `<policy>.jsonl` each) instead of
 * `policies/fixtures`.
 *
 * `--record` also writes `policies/fixtures/recorded/<policy>.json`, which the CI gate replays. It
 * refuses a model other than the pinned reference unless `--force` is given.
 *
 * `--out <dir>` writes `<policy>.json` (a recording) and `<policy>.results.json` (`EvalResult[]`)
 * there instead of to `policies/fixtures/recorded/`, for `eval-compare.ts`. `--facts <groups>` (a
 * comma-separated list) selects (with `--facts-position before|after` the request) the fact groups the gateway derives (they reach the model only through a
 * policy `facts` section); it cannot be combined with `--record`, so only the shipped set is recorded.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { getHealth } from '../src/engines/http.ts';
import { SystemOneRemoteEngine } from '../src/engines/remote.ts';
import type { Engine } from '../src/engines/types.ts';
import { formatEvalSummary, scoreEval, type EvalResult } from '../src/eval.ts';
import {
  RecordingEngine,
  ReplayEngine,
  serializeRecording,
  type Recording,
} from './eval-engines.ts';
import {
  EVAL_REFERENCE,
  FIXTURES_DIR,
  RECORDED_DIR,
  evalFixture,
  floorsFor,
  isReferenceModel,
  type FactsPosition,
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

function fixturePolicies(dir: string, only: string | undefined): string[] {
  const all = readdirSync(dir)
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
  /** Answer from `recorded/<policy>.json` instead of a server; no engine is needed. */
  readonly replay: boolean;
  readonly fixturesDir: string;
  readonly outDir: string | undefined;
  readonly facts?: readonly FactGroup[];
  readonly factsPosition: FactsPosition;
}

interface Answerer {
  readonly engine: Engine;
  /** Set when a live engine's answers are kept. */
  readonly recorder?: RecordingEngine;
}

function replayAnswerer(policyId: string): Answerer {
  const file = join(RECORDED_DIR, `${policyId}.json`);
  return { engine: new ReplayEngine(JSON.parse(readFileSync(file, 'utf8')) as Recording) };
}

async function liveAnswerer(target: Target): Promise<Answerer> {
  const remote = new SystemOneRemoteEngine({
    type: 'systemone-remote',
    url: target.url,
    model: target.model,
  });
  await remote.start();
  const recorder = new RecordingEngine(remote);
  return { engine: recorder, recorder };
}

async function runPolicy(
  policyId: string,
  target: Target | undefined,
  options: RunOptions,
): Promise<boolean> {
  const { engine, recorder } =
    options.replay || target === undefined ? replayAnswerer(policyId) : await liveAnswerer(target);
  console.log(`\n== ${policyId}`);
  const results = await evalFixture(policyId, engine, {
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    factsPosition: options.factsPosition,
    fixturesDir: options.fixturesDir,
    report: (line) => console.log(line),
    onCase: (id) => {
      if (recorder !== undefined) {
        recorder.label = id;
      }
    },
  });
  const summary = scoreEval(results, floorsFor(policyId));
  console.log(formatEvalSummary(summary));
  if (
    recorder !== undefined &&
    target !== undefined &&
    (options.record || options.outDir !== undefined)
  ) {
    writeRecording(policyId, target, recorder, options.outDir ?? RECORDED_DIR);
  }
  if (options.outDir !== undefined) {
    writeResults(options.outDir, policyId, results);
  }
  return summary.passed;
}

function writeResults(dir: string, policyId: string, results: readonly EvalResult[]): void {
  mkdirSync(dir, { recursive: true });
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

function parseOptions(): {
  options: RunOptions;
  model: string | undefined;
  force: boolean;
  policy: string | undefined;
} {
  const { values } = parseArgs({
    options: {
      'policy': { type: 'string' },
      'record': { type: 'boolean' },
      'replay': { type: 'boolean' },
      'force': { type: 'boolean' },
      'model': { type: 'string' },
      'out': { type: 'string' },
      'fixtures': { type: 'string' },
      'facts': { type: 'string' },
      'facts-position': { type: 'string' },
    },
  });
  const facts = parseFacts(values.facts);
  const record = values.record === true;
  const replay = values.replay === true;
  if (record && values.facts !== undefined) {
    throw new Error('--facts cannot be combined with --record: only the shipped set is recorded');
  }
  if (record && (replay || values.fixtures !== undefined)) {
    throw new Error(
      '--record needs a live run over the shipped fixtures (no --replay, --fixtures)',
    );
  }
  return {
    model: values.model,
    force: values.force === true,
    policy: values.policy,
    options: {
      // With --out, the recording goes to the directory rather than the repo.
      record: record && values.out === undefined,
      replay,
      fixturesDir: values.fixtures === undefined ? FIXTURES_DIR : resolve(values.fixtures),
      outDir: values.out,
      // Without --facts the shipped groups apply.
      ...(facts.length === 0 ? {} : { facts }),
      factsPosition: values['facts-position'] === 'after' ? 'after' : 'before',
    },
  };
}

async function main(): Promise<number> {
  const { options, model, force, policy } = parseOptions();
  const target = options.replay ? undefined : await resolveTarget(model);
  if (target === undefined) {
    console.log(`replaying ${RECORDED_DIR}`);
  } else {
    console.log(`engine ${target.engine} model ${target.model} at ${target.url}`);
  }
  if (options.record && target !== undefined && !force && !isReferenceModel(target.model)) {
    throw new Error(
      `refusing to record with ${target.model}: the reference is ${EVAL_REFERENCE.model} (use --force)`,
    );
  }
  if (options.facts !== undefined) {
    console.log(`facts ${options.facts.join(',')}`);
  }
  let ok = true;
  for (const policyId of fixturePolicies(options.fixturesDir, policy)) {
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
