/**
 * The CI eval gate: replays the reference model's recorded answers (`policies/fixtures/recorded/`)
 * through each policy and holds the per-class floors in `policies/fixtures/gate.json`. A policy,
 * prompt or fixture change that alters what the model sees has no recording and fails as stale;
 * re-record with `mise run eval:record`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { formatEvalSummary, scoreEval, type EvalResult, type EvalSummary } from '../src/eval.ts';
import { ReplayEngine, type Recording } from './eval-engines.ts';
import { evalFixture, floorsFor, FIXTURES_DIR, RECORDED_DIR } from './eval-harness.ts';

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
      const { engine, results, summary } = await replay(policyId, recording);
      assert.ok(summary.passed, `${policyId}\n${formatEvalSummary(summary)}`);
      const stale = Object.entries(recording.cases)
        .filter(([key]) => !engine.used.has(key))
        .map(([, recorded]) => recorded.id);
      assert.deepEqual(stale, [], 'stale recording entries; re-record');
      assert.equal(results.length, engine.used.size, 'each case has its own recording');
    });
  }

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
