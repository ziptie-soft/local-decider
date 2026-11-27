import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Action, DecideResponse } from '../shared/decision.ts';
import { DECIDE_USAGE, manualInput, parseDecideArgs } from '../shared/manual.ts';
import { compactModel, shortModel } from '../shared/models.ts';
import {
  nextPollDelay,
  POLL_MAX_MS,
  POLL_UP_MS,
  compactMs,
  ellipsis,
  statusLabel,
  statusSummary,
} from '../shared/poll.ts';
import {
  choicesFor,
  decisionRowSchema,
  LABEL_WINDOW_MS,
  labelChoices,
  permissionNote,
  placeholderRow,
  rowDetail,
  rowExplain,
  rowLabelKind,
  rowId,
  rowSummary,
  rowVisible,
  toRowData,
  type DecisionRow,
} from '../shared/row.ts';
import { response } from './fakes.ts';

function permission(confidence: number, action: Action, mode: 'act' | 'shadow'): DecideResponse {
  return response({
    policy: 'permission',
    action,
    mode,
    enforced: mode === 'act',
    answers: { decision: { type: 'choice', answer: 'allow', probabilities: {}, confidence } },
  });
}

describe('toRowData', () => {
  it('maps a response to schema-valid row data', () => {
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    assert.deepEqual(decisionRowSchema.parse(row), row);
    assert.equal(row.question, 'outcome');
    assert.equal(row.answer, 'done');
    assert.equal(row.attention, false);
    assert.equal(row.error, null);
    assert.equal(rowSummary(row), 'turn-outcome · log · leaned done 80% · shadow');
    assert.equal(rowDetail(row), '2B-qwen3.5-v1-2610 · 120 ms');
  });

  it('flags attention only for an enforced notify', () => {
    const res = response({ action: 'notify', mode: 'act', enforced: true });
    assert.equal(toRowData(res, { source: 'turn', key: 't1', enforced: true }).attention, true);
    const shadow = toRowData(res, { source: 'turn', key: 't1', enforced: false });
    assert.equal(shadow.attention, false);
    assert.equal(
      rowSummary(shadow),
      'turn-outcome · notify · leaned done 80% · act (plugin: shadow)',
    );
  });

  it('handles an engine error without answers', () => {
    const row = toRowData(response({ answers: {}, error: 'engine down', action: 'log' }), {
      source: 'manual',
      key: 'd-1',
      enforced: false,
      note: 'via /decide',
    });
    assert.equal(row.answer, '');
    assert.equal(rowSummary(row), 'turn-outcome · log · no answer · shadow');
    assert.equal(
      rowDetail(row),
      'via /decide · 2B-qwen3.5-v1-2610 · 120 ms · engine error: engine down',
    );
  });

  it('leads permission rows with what happened and never presents a weak answer', () => {
    const weak = toRowData(permission(0.09, 'ask', 'act'), {
      source: 'permission',
      key: 'r1',
      enforced: true,
    });
    assert.equal(rowSummary(weak), 'permission · asked you · unsure 9% · act');
    const allowed = toRowData(permission(0.97, 'allow', 'act'), {
      source: 'permission',
      key: 'r1',
      enforced: true,
      applied: true,
    });
    assert.equal(rowSummary(allowed), 'permission · auto-allowed · leaned allow 97% · act');
    const shadow = toRowData(permission(0.72, 'allow', 'shadow'), {
      source: 'permission',
      key: 'r1',
      enforced: false,
    });
    assert.equal(
      rowSummary(shadow),
      'permission · asked you · would auto-allow · leaned allow 72% · shadow',
    );
  });

  it('carries its row id and feedback options', () => {
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    assert.equal(row.rowId, rowId('turn', 't1'));
    assert.deepEqual(row.options, ['done', 'stuck']);
    assert.equal(row.feedback, null);
  });

  it('parses rows from older versions without the new fields', () => {
    const {
      rowId: _id,
      options: _o,
      feedback: _f,
      ...old
    } = toRowData(response(), {
      source: 'turn',
      key: 't1',
      enforced: false,
    });
    const row = decisionRowSchema.parse(old);
    assert.equal(row.rowId, '');
    assert.deepEqual(row.options, []);
  });

  it('filters rows by visibility', () => {
    const plain = toRowData(response(), { source: 'turn', key: 't', enforced: false });
    const unsure = toRowData(
      response({
        answers: {
          outcome: { type: 'choice', answer: 'done', probabilities: {}, confidence: 0.5 },
        },
      }),
      { source: 'turn', key: 't', enforced: false },
    );
    const manual = { ...plain, source: 'manual' as const };
    assert.equal(rowVisible(plain, 'all'), true);
    assert.equal(rowVisible(plain, 'notable'), false);
    assert.equal(rowVisible(unsure, 'notable'), true);
    assert.equal(rowVisible({ ...plain, applied: true }, 'notable'), true);
    assert.equal(rowVisible({ ...plain, error: 'x' }, 'notable'), true);
    const routine = { ...plain, enforced: true };
    assert.equal(rowVisible(routine, 'notable'), false, 'an enforced log is routine');
    assert.equal(rowVisible({ ...unsure, enforced: true }, 'notable'), false);
    assert.equal(rowVisible({ ...routine, attention: true }, 'notable'), true);
    assert.equal(rowVisible(plain, 'off'), false);
    assert.equal(rowVisible(manual, 'off'), true);
  });

  it('builds stable row ids', () => {
    assert.equal(rowId('turn', 't1'), 'local-decider-turn-t1');
    assert.equal(rowId('turn', 't1'), rowId('turn', 't1'));
  });

  it('shortens model names', () => {
    assert.equal(
      shortModel('StrandsAgents/strands-decider-E4B-gemma4-v1-2610'),
      'E4B-gemma4-v1-2610',
    );
    assert.equal(shortModel('other'), 'other');
  });
});

describe('polling', () => {
  it('polls steadily while up and backs off while down', () => {
    assert.equal(nextPollDelay(0), POLL_UP_MS);
    assert.equal(nextPollDelay(1), POLL_UP_MS);
    assert.equal(nextPollDelay(2), POLL_UP_MS * 2);
    assert.equal(nextPollDelay(3), POLL_UP_MS * 4);
    assert.equal(nextPollDelay(50), POLL_MAX_MS);
    assert.equal(nextPollDelay(Number.NaN), POLL_UP_MS);
  });

  it('labels the sidebar row', () => {
    const up = { up: true, model: 'StrandsAgents/strands-decider-2B-hobson-v21', p50Ms: 87.4 };
    assert.equal(statusLabel(undefined), 'Decider…');
    assert.equal(statusLabel({ up: false, model: null, p50Ms: null }), 'Offline');
    assert.equal(statusLabel({ ...up, status: 'degraded' }), 'Loading…');
    assert.equal(statusLabel(up), 'hobson 2B · 87ms');
    assert.equal(statusLabel({ ...up, p50Ms: 7847 }), 'hobson 2B · 7.8s');
    assert.equal(statusLabel(up, 'model'), 'hobson 2B');
    assert.equal(statusLabel(up, 'latency'), '87ms');
    assert.equal(statusLabel(up, 'minimal'), 'Decider');
    assert.equal(
      statusLabel({ ...up, model: 'someone/a-very-long-custom-model-name' }),
      'someone/a-very-long-c…',
    );
  });

  it('names the engine in the sidebar label when it fits', () => {
    const npu = { up: true, engine: 'fastflowlm', engineTag: 'NPU', model: 'd3:nano', p50Ms: 300 };
    assert.equal(statusLabel(npu), 'd3:nano · NPU · 300ms');
    assert.equal(statusLabel(npu, 'model'), 'd3:nano · NPU');
    assert.equal(statusLabel(npu, 'latency'), '300ms');
    const strands = {
      up: true,
      engine: 'strands-decider',
      engineTag: 'PyTorch',
      model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
      p50Ms: 8487,
    };
    assert.equal(statusLabel(strands), 'qwen3.5 2B · 8.5s');
    assert.equal(statusLabel(strands, 'model'), 'qwen3.5 2B · PyTorch');
  });

  it('shortens models and latency for the sidebar', () => {
    assert.equal(compactModel('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610'), 'qwen3.5 2B');
    assert.equal(compactModel('StrandsAgents/strands-decider-E4B-gemma4-v1-2610'), 'gemma4 E4B');
    assert.equal(compactModel('custom/x'), 'custom/x');
    assert.equal(compactMs(850.4), '850ms');
    assert.equal(compactMs(12_400), '12s');
    assert.equal(ellipsis('abcdef', 4), 'abc…');
    assert.equal(ellipsis('abc', 4), 'abc');
  });

  it('summarises the status for settings', () => {
    const base = { gatewayUrl: 'http://127.0.0.1:8765', detail: null, p50Ms: null, model: null };
    assert.match(statusSummary({ ...base, up: false, engineState: null }), /Unreachable at/);
    assert.equal(
      statusSummary({
        ...base,
        up: true,
        engineState: 'starting',
        model: 'StrandsAgents/strands-decider-2B-hobson-v21',
        detail: 'restart 1',
      }),
      'starting · 2B-hobson-v21 · restart 1',
    );
  });
});

describe('/decide arguments', () => {
  it('parses a policy and free text', () => {
    assert.deepEqual(parseDecideArgs('routing  add a flag\nplease'), {
      policy: 'routing',
      text: 'add a flag\nplease',
    });
    assert.equal(parseDecideArgs('routing'), null);
    assert.equal(parseDecideArgs(''), null);
    assert.equal(parseDecideArgs('Bad! text'), null);
    assert.match(DECIDE_USAGE, /\/decide <policy> <text>/);
  });

  it('fills the input key each default policy reads', () => {
    assert.deepEqual(manualInput('routing', 'x'), { prompt: 'x' });
    assert.deepEqual(manualInput('command-risk', 'rm -rf /'), { command: 'rm -rf /' });
    assert.deepEqual(manualInput('custom', 'x'), { text: 'x' });
  });
});

describe('permission labels', () => {
  const base = toRowData(permission(0.8, 'ask', 'shadow'), {
    source: 'permission',
    key: 'r1',
    enforced: false,
  });
  const row = (over: Partial<DecisionRow>): DecisionRow => ({ ...base, ...over });
  const declined = row({ feedback: 'decline', answeredAt: 1_000 });

  it('starts without label state and takes vetoable from the precedent key', () => {
    assert.equal(base.answeredAt, null);
    assert.equal(base.label, null);
    assert.equal(base.vetoable, false);
    const keyed = toRowData(response({ precedentKey: 'k' }), {
      source: 'permission',
      key: 'r1',
      enforced: false,
    });
    assert.equal(keyed.vetoable, true);
  });

  it('parses a row without the new fields using defaults', () => {
    const { answeredAt, vetoable, label, ...old } = base;
    assert.equal(answeredAt, null);
    assert.equal(vetoable, false);
    assert.equal(label, null);
    const parsed = decisionRowSchema.parse(old);
    assert.deepEqual([parsed.answeredAt, parsed.vetoable, parsed.label], [null, false, null]);
  });

  it('classifies which rows can be labelled', () => {
    assert.equal(rowLabelKind(declined), 'declined');
    assert.equal(rowLabelKind(row({ feedback: 'interrupted', answeredAt: 1 })), 'interrupted');
    const auto = row({ applied: true, vetoable: true, answeredAt: 1 });
    assert.equal(rowLabelKind(auto), 'auto-allowed');
    assert.equal(rowLabelKind({ ...auto, vetoable: false }), null);
    assert.equal(rowLabelKind({ ...declined, answeredAt: null }), null);
    assert.equal(rowLabelKind({ ...declined, source: 'turn' }), null);
    assert.equal(rowLabelKind(row({ feedback: 'deny', answeredAt: 1 })), null);
    assert.equal(rowLabelKind(row({ feedback: 'allow', answeredAt: 1 })), null);
  });

  it('offers one chip on auto-allows and three after a decline', () => {
    assert.deepEqual(choicesFor('auto-allowed'), ['unsafe']);
    assert.deepEqual(choicesFor('declined'), ['safe', 'unsafe', 'skip']);
    assert.deepEqual(choicesFor('interrupted'), ['safe', 'unsafe', 'skip']);
  });

  it('hides chips after the window, once labelled, but not for a future time', () => {
    assert.equal(labelChoices(declined, 1_000 + LABEL_WINDOW_MS).length, 3);
    assert.deepEqual(labelChoices(declined, 1_000 + LABEL_WINDOW_MS + 1), []);
    assert.deepEqual(labelChoices({ ...declined, label: 'skip' }, 2_000), []);
    assert.equal(labelChoices({ ...declined, answeredAt: 9_000 }, 2_000).length, 3);
  });

  it('words the answer line', () => {
    assert.equal(permissionNote(base), null);
    assert.equal(permissionNote(row({ feedback: 'allow' })), '✓ You allowed');
    assert.equal(permissionNote(declined), '✗ You declined');
    assert.equal(
      permissionNote({ ...declined, label: 'safe' }),
      '✗ You declined · not a safety issue',
    );
    assert.equal(
      permissionNote({ ...declined, label: 'unsafe' }),
      '✗ You declined · marked unsafe',
    );
    assert.equal(permissionNote({ ...declined, label: 'skip' }), '✗ You declined');
    const stopped = row({ feedback: 'interrupted' });
    assert.equal(permissionNote(stopped), '■ You stopped the agent');
    assert.equal(
      permissionNote({ ...stopped, label: 'safe' }),
      '■ You stopped the agent · not a safety issue',
    );
    assert.equal(permissionNote(row({ feedback: 'deny' })), '✗ You denied');
    assert.equal(permissionNote(row({ feedback: 'maybe' })), 'You answered: maybe');
    assert.equal(
      permissionNote(row({ applied: true, label: 'unsafe' })),
      '✗ Marked unsafe · past allows no longer lower the threshold; high-confidence rules may still allow it',
    );
  });
});

const explainResponse = (extra: Partial<DecideResponse> = {}): DecideResponse =>
  response({
    policy: 'permission',
    action: 'allow',
    answers: {
      verdict: {
        type: 'choice',
        answer: 'allow',
        probabilities: { allow: 0.7812, deny: 0.15, unsure: 0.0688 },
        confidence: 0.78,
      },
    },
    ...extra,
  });

describe('row explanation', () => {
  const res = explainResponse;
  const rowOf = (extra: Partial<DecideResponse> = {}, pluginMode?: 'act' | 'shadow'): DecisionRow =>
    toRowData(res(extra), {
      source: 'permission',
      key: 'r1',
      enforced: false,
      ...(pluginMode === undefined ? {} : { pluginMode }),
    });
  const threshold = {
    key: 'verdict.allow',
    question: 'verdict',
    answer: 'allow',
    action: 'allow',
    kind: 'minProbability' as const,
    default: 0.85,
    value: 0.85,
    floor: 0.5,
  };

  it('keeps rounded probabilities, rule, precedent, variant and truncation', () => {
    const row = rowOf({
      rule: 2,
      precedent: { allows: 3, denies: 0 },
      variant: 'strict',
      truncated: ['History'],
    });
    assert.deepEqual(row.probabilities, { allow: 0.781, deny: 0.15, unsure: 0.069 });
    assert.deepEqual(
      [row.rule, row.precedent, row.variant, row.truncated],
      [2, { allows: 3, denies: 0 }, 'strict', true],
    );
  });

  it('caps probabilities at twelve entries', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`o${String(i)}`, 0.05]));
    const row = rowOf({
      answers: { verdict: { type: 'choice', answer: 'o0', probabilities: many, confidence: 0.05 } },
    });
    assert.equal(Object.keys(row.probabilities).length, 12);
  });

  it('parses old row data with defaults', () => {
    const { probabilities, rule, precedent, variant, truncated, pluginMode, ...old } = rowOf();
    void [probabilities, rule, precedent, variant, truncated, pluginMode];
    const row = decisionRowSchema.parse(old);
    assert.deepEqual(row.probabilities, {});
    assert.deepEqual(
      [row.rule, row.precedent, row.truncated, row.pluginMode],
      [-1, null, false, null],
    );
  });

  it('explains a default-rule row', () => {
    const lines = rowExplain(rowOf({ rule: -1 }), [threshold]);
    assert.deepEqual(lines.slice(0, 3), [
      'verdict: allow 0.78 · deny 0.15 · unsure 0.07',
      'rule: none matched → default allow',
      'thresholds now: allow at p(allow) ≥ 0.85',
    ]);
    assert.equal(lines.at(-1), rowDetail(rowOf()));
  });

  it('explains a matched rule, precedent and truncation, and omits unknown thresholds', () => {
    const lines = rowExplain(
      rowOf({ rule: 1, precedent: { allows: 1, denies: 2 }, variant: 'v', truncated: ['A'] }),
      null,
    );
    assert.ok(lines.includes('rule: #1 matched → allow'));
    assert.ok(lines.includes('precedent: 1 allow · 2 denies'));
    assert.ok(lines.includes('variant: v'));
    assert.ok(lines.includes('input truncated'));
    assert.ok(!lines.some((l) => l.startsWith('thresholds')));
  });

  it('flags a plugin act the gateway did not enforce', () => {
    const row = rowOf({ mode: 'shadow' }, 'act');
    assert.match(rowSummary(row), /act \(gateway: shadow\)$/);
    assert.match(rowSummary(rowOf({ mode: 'shadow' }, 'shadow')), /shadow$/);
    assert.doesNotMatch(rowSummary({ ...row, error: 'x' }), /gateway:/);
  });

  it('keeps a maximal row under 8 KB', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`${'k'.repeat(90)}${String(i)}`, 0.123]),
    );
    const row = rowOf({
      answers: { verdict: { type: 'choice', answer: 'x', probabilities: many, confidence: 1 } },
      variant: 'v'.repeat(100),
      precedent: { allows: 99, denies: 99 },
    });
    assert.ok(JSON.stringify(row).length < 8192);
  });
});

const rowWith = (modelSource?: DecideResponse['modelSource'], error?: string): DecisionRow =>
  toRowData(
    response({
      ...(modelSource === undefined ? {} : { modelSource }),
      ...(error === undefined ? {} : { error }),
    }),
    { source: 'turn', key: 't1', enforced: false },
  );

describe('model source on a row', () => {
  const base = '2B-qwen3.5-v1-2610 · 120 ms';

  it('says nothing for default and for an older gateway, and keeps null', () => {
    for (const row of [rowWith('default'), rowWith()]) {
      assert.equal(rowDetail(row), base);
    }
    assert.equal(rowWith('default').modelSource, 'default');
    assert.equal(rowWith().modelSource, null);
  });

  it('names an own model, a fallback and a skipped decision', () => {
    assert.equal(rowDetail(rowWith('policy')), `${base} · own model`);
    assert.equal(rowDetail(rowWith('fallback')), `${base} · default (own model unavailable)`);
    assert.equal(rowDetail(rowWith('unavailable')), `${base} · skipped: own model unavailable`);
  });

  it('shows the text in the expanded explanation and keeps the value in the row data', () => {
    const row = rowWith('fallback');
    assert.equal(row.modelSource, 'fallback');
    assert.equal(rowExplain(row, null).at(-1), rowDetail(row));
    assert.deepEqual(decisionRowSchema.parse(row), row);
  });

  it('drops a value it does not know, and parses old row data as null', () => {
    const unknown = response({ modelSource: 'elsewhere' as unknown as 'policy' });
    const row = toRowData(unknown, { source: 'turn', key: 't1', enforced: false });
    assert.equal(row.modelSource, null);
    const { modelSource, ...old } = rowWith('policy');
    void modelSource;
    assert.equal(decisionRowSchema.parse(old).modelSource, null);
  });

  it('keeps a persisted row whose model source is unknown, with the source as null', () => {
    const stored = { ...rowWith('policy'), modelSource: 'elsewhere' };
    const row = decisionRowSchema.parse(stored);
    assert.equal(row.modelSource, null);
    assert.equal(row.policy, 'turn-outcome');
    assert.equal(decisionRowSchema.parse({ ...stored, modelSource: 7 }).modelSource, null);
  });

  it('gives the reason once for an unavailable model, not also as an engine error', () => {
    assert.equal(
      rowDetail(rowWith('unavailable', 'policy model unavailable: benchmark running')),
      `${base} · skipped: own model unavailable (benchmark running)`,
    );
    assert.equal(rowDetail(rowWith('unavailable')), `${base} · skipped: own model unavailable`);
    assert.equal(
      rowDetail(rowWith('unavailable', 'policy model unavailable: ')),
      `${base} · skipped: own model unavailable · engine error: policy model unavailable: `,
    );
    assert.equal(
      rowDetail(rowWith('unavailable', 'timeout')),
      `${base} · skipped: own model unavailable · engine error: timeout`,
    );
  });

  it('leaves placeholder rows unchanged', () => {
    for (const state of ['pending', 'skipped'] as const) {
      const row = placeholderRow('permission', 'r1', 'permission', state, 'busy');
      assert.equal(row.modelSource, null);
      assert.equal(rowDetail(row), '0 ms');
    }
    assert.equal(
      rowSummary(placeholderRow('permission', 'r1', 'permission', 'pending')),
      'permission · deciding… · act',
    );
  });
});
