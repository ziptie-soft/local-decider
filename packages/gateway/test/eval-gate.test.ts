/**
 * The CI eval gate: replays the reference model's recorded answers (`policies/fixtures/recorded/`)
 * through each policy and holds the per-class floors in `policies/fixtures/gate.json`. A policy,
 * prompt or fixture change that alters what the model sees has no recording and fails as stale;
 * re-record with `mise run eval:record`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatEvalSummary, scoreEval, type EvalResult, type EvalSummary } from '../src/eval.ts';
import { ReplayEngine, type Recording } from './eval-engines.ts';
import {
  evalFixture,
  floorsFor,
  isReferenceModel,
  FIXTURES_DIR,
  RECORDED_DIR,
} from './eval-harness.ts';

function policyIds(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => basename(name, '.jsonl'))
    .toSorted();
}

function loadRecording(policyId: string): Recording {
  return JSON.parse(readFileSync(join(RECORDED_DIR, `${policyId}.json`), 'utf8')) as Recording;
}

interface Replayed {
  readonly engine: ReplayEngine;
  readonly results: EvalResult[];
  readonly summary: EvalSummary;
}

async function replay(policyId: string, recording: Recording): Promise<Replayed> {
  const engine = new ReplayEngine(recording);
  const results = await evalFixture(policyId, engine);
  return { engine, results, summary: scoreEval(results, floorsFor(policyId)) };
}

describe('recorded eval gate', () => {
  for (const policyId of policyIds()) {
    it(`${policyId} holds its floors against the recording`, async () => {
      const recording = loadRecording(policyId);
      assert.ok(
        isReferenceModel(recording.model),
        `${policyId} was recorded with ${recording.model}, not the reference model; re-record`,
      );
      const { engine, results, summary } = await replay(policyId, recording);
      assert.ok(summary.passed, `${policyId}\n${formatEvalSummary(summary)}`);
      const stale = Object.entries(recording.cases)
        .filter(([key]) => !engine.used.has(key))
        .map(([, recorded]) => recorded.id);
      assert.deepEqual(stale, [], 'stale recording entries; re-record');
      assert.equal(results.length, engine.used.size, 'each case has its own recording');
    });
  }

  it('replays a policy through eval-live --replay to the same results as the gate', async () => {
    const policyId = 'turn-outcome';
    const out = mkdtempSync(join(tmpdir(), 'eval-replay-'));
    try {
      execFileSync(
        process.execPath,
        [
          '--conditions=source',
          fileURLToPath(new URL('./eval-live.ts', import.meta.url)),
          '--replay',
          '--policy',
          policyId,
          '--out',
          out,
        ],
        { stdio: 'pipe' },
      );
      const cli = JSON.parse(
        readFileSync(join(out, `${policyId}.results.json`), 'utf8'),
      ) as unknown;
      const { results } = await replay(policyId, loadRecording(policyId));
      assert.deepEqual(cli, JSON.parse(JSON.stringify(results)));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('reads cases from another fixtures directory', async () => {
    const policyId = 'turn-outcome';
    const dir = mkdtempSync(join(tmpdir(), 'eval-fixtures-'));
    try {
      mkdirSync(dir, { recursive: true });
      cpSync(join(FIXTURES_DIR, `${policyId}.jsonl`), join(dir, `${policyId}.jsonl`));
      const engine = new ReplayEngine(loadRecording(policyId));
      const results = await evalFixture(policyId, engine, { fixturesDir: dir });
      assert.ok(results.length > 0);
      await assert.rejects(evalFixture(policyId, engine, { fixturesDir: join(dir, 'missing') }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a case that has no recording', async () => {
    const policyId = 'turn-outcome';
    const recording = loadRecording(policyId);
    const [dropped, ...rest] = Object.keys(recording.cases);
    assert.ok(dropped !== undefined);
    const trimmed: Recording = {
      ...recording,
      cases: Object.fromEntries(rest.map((key) => [key, recording.cases[key]!])),
    };
    const { summary } = await replay(policyId, trimmed);
    assert.equal(summary.unavailable, 1);
    assert.equal(summary.passed, false);
  });

  it('detects a recording entry no fixture uses', async () => {
    const policyId = 'turn-outcome';
    const recording = loadRecording(policyId);
    const first = Object.values(recording.cases)[0];
    assert.ok(first !== undefined);
    const extra: Recording = {
      ...recording,
      cases: { ...recording.cases, 'stale-key': first },
    };
    const { engine } = await replay(policyId, extra);
    assert.equal(Object.keys(extra.cases).length - engine.used.size, 1);
  });
});
