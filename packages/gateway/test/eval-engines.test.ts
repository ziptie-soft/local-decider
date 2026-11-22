import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EngineError } from '../src/engines/types.ts';
import {
  RecordingEngine,
  recordingKey,
  ReplayEngine,
  serializeRecording,
  type Recording,
} from './eval-engines.ts';
import { FakeEngine } from './helpers.ts';

const QUESTIONS = {
  verdict: { type: 'choice', instructions: 'Pick.', criteria: { allow: 'a', ask: 'b' } },
} as const;
const REQUEST: SystemOneRequest = { state: '# Task\nls', questions: QUESTIONS, model: 'm1' };
const SIGNAL = new AbortController().signal;

const ANSWER: SystemOneResponse['answers'] = {
  verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.9, ask: 0.1 } },
};

function recording(key: string): Recording {
  return {
    version: 1,
    engine: 'strands-decider',
    model: 'ref-model',
    recordedAt: '2026-11-22',
    cases: { [key]: { id: 'case-a', answers: ANSWER } },
  };
}

describe('recordingKey', () => {
  it('is stable under key order and ignores the model', () => {
    const reordered: SystemOneRequest = {
      questions: {
        verdict: { criteria: { ask: 'b', allow: 'a' }, instructions: 'Pick.', type: 'choice' },
      },
      state: '# Task\nls',
      model: 'other',
    };
    assert.equal(recordingKey(reordered), recordingKey(REQUEST));
    assert.notEqual(recordingKey({ ...REQUEST, state: '# Task\nrm' }), recordingKey(REQUEST));
  });
});

describe('ReplayEngine', () => {
  it('returns a recorded answer and tracks used keys', async () => {
    const key = recordingKey(REQUEST);
    const engine = new ReplayEngine(recording(key));
    assert.equal(engine.id, 'strands-decider');
    assert.equal(engine.model, 'ref-model');
    const response = await engine.decide(REQUEST);
    assert.deepEqual(response.answers, ANSWER);
    assert.deepEqual([...engine.used], [key]);
  });

  it('throws EngineError on a miss', async () => {
    const engine = new ReplayEngine(recording('other-key'));
    await assert.rejects(
      engine.decide(REQUEST),
      (error: unknown) => error instanceof EngineError && error.message === 'no recording',
    );
    assert.equal(engine.used.size, 0);
  });
});

describe('RecordingEngine', () => {
  it('round-trips through ReplayEngine', async () => {
    const inner = new FakeEngine({ allow: 0.8, ask: 0.2 });
    const recorder = new RecordingEngine(inner);
    recorder.label = 'case-a';
    const live = await recorder.decide(REQUEST, SIGNAL);
    const key = recordingKey(REQUEST);
    assert.deepEqual([...recorder.cases.keys()], [key]);
    assert.equal(recorder.cases.get(key)?.id, 'case-a');

    const replay = new ReplayEngine({
      version: 1,
      engine: recorder.id,
      model: recorder.model,
      recordedAt: '2026-11-22',
      cases: Object.fromEntries(recorder.cases),
    });
    assert.deepEqual((await replay.decide(REQUEST)).answers, live.answers);
  });

  it('serializes sorted, cases by id, with no latency or usage', () => {
    const text = serializeRecording({
      ...recording('k2'),
      cases: {
        k2: { id: 'b', answers: ANSWER },
        k1: {
          id: 'a',
          answers: {
            verdict: { probabilities: { ask: 0.1, allow: 0.9 }, choice: 'allow', type: 'choice' },
          },
        },
      },
    });
    assert.ok(text.endsWith('\n'));
    const parsed = JSON.parse(text) as Recording;
    assert.deepEqual(Object.keys(parsed.cases), ['k1', 'k2']);
    assert.ok(text.indexOf('"allow": 0.9') < text.indexOf('"ask": 0.1'));
    assert.ok(!/latency|usage/.test(text));
  });
});
