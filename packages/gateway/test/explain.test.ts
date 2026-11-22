import { parsePolicy, type OutcomeRecord, type UsageRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Decider } from '../src/decider.ts';
import { agentView, explainDecision, formatExplain, type ExplainContext } from '../src/explain.ts';
import { defaultPolicyDir, type LoadedPolicy } from '../src/policies.ts';
import { FakeEngine, tempLog } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

const source = join(defaultPolicyDir(), 'permission.yaml');
const policy = parsePolicy(readFileSync(source, 'utf8'));
const loaded: LoadedPolicy = { policy, mode: 'act', source };
const context: ExplainContext = { policies: new Map([['permission', loaded]]) };
const signal = (): AbortSignal => new AbortController().signal;

const SENTINEL = 'SENTINEL-7f3a91';

async function decide(
  probs: Record<string, number>,
  input: Record<string, unknown> = {},
): Promise<ReturnType<ReturnType<typeof tempLog>['findDecision']>> {
  const log = tempLog();
  const decider = new Decider({
    engine: new FakeEngine(probs),
    policies: new Map([['permission', loaded]]),
    log,
    decisionTimeoutMs: 2000,
  });
  const response = await decider.decide(
    'permission',
    {
      harness: 'claude-code',
      input: { project: '/p', tool: 'Bash', request: { command: 'ls' }, history: 'h', ...input },
      workspace: { cwd: '/p' },
    },
    signal(),
  );
  return log.findDecision(response.decisionId);
}

function recorded(
  probabilities: Record<string, number>,
  answer: string,
  extra: Parameters<typeof makeShadowRecord>[1] = {},
): ReturnType<typeof makeShadowRecord> {
  return makeShadowRecord('d-1', {
    answers: { verdict: { type: 'choice', answer, probabilities, confidence: 0.6 } },
    ...extra,
  });
}

const outcome = (
  name: string,
  extra: Partial<OutcomeRecord> = {},
  ts = '2026-11-10T00:00:05.000Z',
): OutcomeRecord => ({
  kind: 'outcome',
  ts,
  decisionId: 'd-1',
  outcome: name,
  source: 'user',
  verified: true,
  ...extra,
});

const row = (extra: Partial<UsageRecord>): UsageRecord => ({
  kind: 'usage',
  ts: '2026-11-10T00:00:05.000Z',
  decisionId: 'd-1',
  inputTokens: 10,
  cachedInputTokens: 4,
  outputTokens: 2,
  verified: true,
  ...extra,
});

describe('explainDecision', () => {
  it('names the matched rule with its threshold gap and says the rules are unchanged', async () => {
    const record = await decide({ allow: 0.97, ask: 0.02, deny: 0.01 });
    assert.ok(record);
    const view = explainDecision(record, [], [], context);
    assert.equal(view.rule?.index, 1);
    assert.equal(view.rule?.action, 'allow');
    assert.equal(view.rule?.threshold?.key, 'verdict.allow');
    assert.equal(view.rule?.threshold?.value, 0.85);
    assert.ok(Math.abs((view.rule?.threshold?.gap ?? 0) - 0.12) < 0.02);
    assert.equal(view.rule?.changedSinceDecision, false);
    assert.equal(view.primary?.question, 'verdict');
    assert.equal(view.tool, 'Bash');
    assert.match(
      formatExplain(view),
      /rule: #1 → allow when verdict\.allow ≥ 0\.85 .*unchanged since/,
    );
  });

  it('shows the default rule when nothing matched', async () => {
    const record = await decide({ allow: 0.3, ask: 0.6, deny: 0.1 });
    assert.ok(record);
    const view = explainDecision(record, [], [], context);
    assert.equal(view.rule?.index, -1);
    assert.equal(view.rule?.action, 'ask');
    assert.match(formatExplain(view), /rule: default → ask/);
  });

  it('reports changedSinceDecision true after an override, false unchanged and null when unknown', async () => {
    const record = await decide({ allow: 0.97, ask: 0.02, deny: 0.01 });
    assert.ok(record);
    const changed = explainDecision(record, [], [], {
      ...context,
      overrides: { permission: { 'verdict.allow': 0.9 } },
    });
    assert.equal(changed.rule?.changedSinceDecision, true);
    assert.match(formatExplain(changed), /may point at another rule/);
    const { rulesHash: _drop, ...bare } = record;
    assert.equal(explainDecision(bare, [], [], context).rule?.changedSinceDecision, null);
    assert.equal(
      explainDecision(record, [], [], { policies: new Map() }).rule?.changedSinceDecision,
      null,
    );
  });

  it('prints not recorded for rows from before F6', () => {
    const view = explainDecision(
      recorded({ allow: 0.7, ask: 0.2, deny: 0.1 }, 'allow'),
      [],
      [],
      context,
    );
    assert.equal(view.rule, undefined);
    assert.match(formatExplain(view), /rule: not recorded \(before F6\)/);
    assert.match(formatExplain(view), /precedent: not recorded \(before F6\)/);
  });

  it('computes the margin of the primary question', () => {
    const view = explainDecision(
      recorded({ allow: 0.7, ask: 0.2, deny: 0.1 }, 'allow'),
      [],
      [],
      context,
    );
    assert.equal(view.primary?.margin, 0.5);
    assert.match(
      formatExplain(view),
      /verdict: allow 0\.70 · ask 0\.20 · deny 0\.10 \(margin 0\.50\)/,
    );
  });

  it('folds only verified outcomes, so a veto after a decline is in force', () => {
    const record = recorded({ allow: 0.9, ask: 0.1 }, 'allow');
    const view = explainDecision(
      record,
      [
        outcome('decline'),
        outcome('unsafe'),
        outcome('allow', { verified: false, source: 'unverified', claimedSource: 'user' }),
      ],
      [],
      context,
    );
    assert.equal(view.effectiveOutcome, 'unsafe');
    assert.equal(view.outcomes.length, 3);
    assert.equal(view.outcomes[2]?.verified, false);
    const first = explainDecision(record, [outcome('allow'), outcome('unsafe')], [], context);
    assert.equal(first.effectiveOutcome, 'allow');
    assert.equal(
      explainDecision(record, [outcome('allow', { verified: false })], [], context)
        .effectiveOutcome,
      undefined,
    );
  });

  it('sums verified usage only, once per turn', () => {
    const view = explainDecision(
      recorded({ allow: 0.9, ask: 0.1 }, 'allow'),
      [],
      [
        row({ turnId: 'a', costUsd: 0.01 }),
        row({ turnId: 'a' }),
        row({ turnId: 'b' }),
        row({ verified: false }),
      ],
      context,
    );
    assert.deepEqual(view.usage, {
      turns: 2,
      inputTokens: 20,
      cachedInputTokens: 8,
      outputTokens: 4,
      costUsd: 0.01,
    });
  });

  it('cuts the stored error to its first line', () => {
    const view = explainDecision(
      recorded({ allow: 0.9, ask: 0.1 }, 'allow', { error: `boom\n${'x'.repeat(400)}` }),
      [],
      [],
      context,
    );
    assert.equal(view.error, 'boom');
    assert.equal(
      explainDecision(recorded({ a: 1 }, 'a', { error: 'y'.repeat(400) }), [], [], context).error
        ?.length,
      160,
    );
  });
});

describe('hash-only', () => {
  it('never carries state, subject or command text in the view, its JSON or its text', async () => {
    const record = await decide(
      { allow: 0.97, ask: 0.02, deny: 0.01 },
      {
        request: { command: `echo ${SENTINEL}-command` },
        history: `${SENTINEL}-history`,
        task: `${SENTINEL}-task`,
        subject: `Bash: ${SENTINEL}-subject`,
      },
    );
    assert.ok(record);
    const view = explainDecision(record, [], [], context);
    assert.ok(!JSON.stringify(view).includes('SENTINEL'));
    assert.ok(!formatExplain(view).includes('SENTINEL'));
    assert.ok(!JSON.stringify(agentView(view)).includes('SENTINEL'));
    assert.ok(!JSON.stringify(record).includes('SENTINEL'));
  });
});

describe('agentView', () => {
  it('has exactly the keys the reason text already shows', async () => {
    const record = await decide({ allow: 0.97, ask: 0.02, deny: 0.01 });
    assert.ok(record);
    const view = agentView(explainDecision(record, [outcome('allow')], [], context));
    assert.deepEqual(Object.keys(view).toSorted(), [
      'action',
      'decisionId',
      'enforced',
      'failedOpen',
      'policy',
      'primary',
      'truncated',
    ]);
    assert.deepEqual(Object.keys(view.primary ?? {}).toSorted(), [
      'answer',
      'confidence',
      'question',
    ]);
    assert.equal(view.failedOpen, false);
    assert.equal(view.truncated, false);
    assert.equal(String(view.primary?.confidence).length <= 4, true);
  });

  it('flags a failed open and a truncation', () => {
    const view = agentView(
      explainDecision(
        recorded({ allow: 0.9, ask: 0.1 }, 'allow', {
          error: 'engine down',
          truncated: ['Request'],
        }),
        [],
        [],
        context,
      ),
    );
    assert.equal(view.failedOpen, true);
    assert.equal(view.truncated, true);
  });
});
