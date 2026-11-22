import {
  rulesHash,
  withThresholds,
  type Action,
  type Answers,
  type OutcomeRecord,
  type Policy,
  type PolicyRule,
  type ShadowRecord,
  type UsageRecord,
} from '@ziptie-soft/local-decider-core';

import { correctedOutcome, isVerifiedOutcome } from './outcome-labels.ts';

/**
 * Why one decision came out as it did, built from the hash-only store row plus the policy now in
 * force. It never holds request text: the store never kept any.
 */
export interface ExplainView {
  readonly decisionId: string;
  readonly ts: string;
  readonly policy: string;
  readonly variant?: string;
  readonly harness: string;
  readonly scope?: string;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly permissionMode?: string;
  readonly subagent?: boolean;
  readonly tool?: string;
  readonly mode: string;
  readonly action: Action;
  readonly enforced: boolean;
  readonly cached?: boolean;
  readonly answers: Readonly<
    Record<string, { answer: string; confidence: number; probabilities: Record<string, number> }>
  >;
  readonly primary?: { question: string; answer: string; confidence: number; margin: number };
  readonly rule?: ExplainRule;
  readonly precedent?: { allows: number; denies: number; key?: string };
  readonly redactions?: Readonly<Record<string, number>>;
  readonly truncated?: readonly string[];
  readonly engine: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly queueMs?: number;
  readonly engineMs?: number;
  readonly stateTokens?: number;
  readonly error?: string;
  readonly outcomes: readonly ExplainOutcome[];
  readonly effectiveOutcome?: string;
  readonly usage?: ExplainUsage;
  readonly inputHash: string;
}

export interface ExplainRule {
  /** Rule index, -1 for the policy default. */
  readonly index: number;
  /** Action of that rule in the policy now in force; absent when the policy is not loaded. */
  readonly action?: Action;
  readonly when?: PolicyRule['when'];
  readonly threshold?: { key: string; kind: string; value: number; gap: number };
  /** True or false when the rules changed since the decision; null when that is unknown. */
  readonly changedSinceDecision: boolean | null;
}

export interface ExplainOutcome {
  readonly ts: string;
  readonly outcome: string;
  readonly source: string;
  readonly verified: boolean;
  readonly claimedSource?: string;
}

export interface ExplainUsage {
  readonly turns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

/** What an agent may see of a decision: exactly what the reason text already tells it. */
export interface AgentView {
  readonly decisionId: string;
  readonly policy: string;
  readonly action: Action;
  readonly enforced: boolean;
  readonly primary?: { question: string; answer: string; confidence: number };
  readonly failedOpen: boolean;
  readonly truncated: boolean;
}

/** Policies to look rules up in, and `config.yaml` threshold overrides per policy id. */
export interface ExplainContext {
  readonly policies: ReadonlyMap<string, { readonly policy: Policy }>;
  readonly overrides?: Readonly<Record<string, Readonly<Record<string, number> | undefined>>>;
}

const ERROR_CHARS = 160;
const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function effectivePolicy(record: ShadowRecord, context: ExplainContext): Policy | undefined {
  const id = record.variant ?? record.policy;
  const loaded = context.policies.get(id);
  return loaded === undefined
    ? undefined
    : withThresholds(loaded.policy, context.overrides?.[id] ?? {});
}

function answersView(answers: Answers): ExplainView['answers'] {
  return Object.fromEntries(
    Object.entries(answers).map(([question, a]) => [
      question,
      {
        answer: a.answer,
        confidence: round(a.confidence, 3),
        probabilities: Object.fromEntries(
          Object.entries(a.probabilities).map(([k, p]) => [k, round(p, 3)]),
        ),
      },
    ]),
  );
}

/** p(top) − p(second) of one answer's distribution. */
function margin(probabilities: Readonly<Record<string, number>>): number {
  const [top = 0, second = 0] = Object.values(probabilities).toSorted((a, b) => b - a);
  return round(top - second, 3);
}

function primaryQuestion(answers: Answers, rule: PolicyRule | undefined): string | undefined {
  const asked = rule?.when.question;
  if (asked !== undefined && answers[asked] !== undefined) {
    return asked;
  }
  return Object.keys(answers)[0];
}

function primaryView(
  answers: Answers,
  question: string | undefined,
): ExplainView['primary'] | undefined {
  const answer = question === undefined ? undefined : answers[question];
  if (question === undefined || answer === undefined) {
    return undefined;
  }
  return {
    question,
    answer: answer.answer,
    confidence: round(answer.confidence, 3),
    margin: margin(answer.probabilities),
  };
}

/** The question the matched rule reads, else the first one, with the answer given. */
export function primaryFor(
  record: ShadowRecord,
  policy: Policy | undefined,
): ExplainView['primary'] | undefined {
  const matched = record.rule === undefined ? undefined : policy?.rules[record.rule];
  return primaryView(record.answers, primaryQuestion(record.answers, matched));
}

function thresholdView(rule: PolicyRule, answers: Answers): ExplainRule['threshold'] | undefined {
  const { question, answer, minProbability, minConfidence } = rule.when;
  const given = answers[question];
  if (given === undefined) {
    return undefined;
  }
  const key = `${question}.${answer}`;
  if (minProbability !== undefined) {
    const p = given.probabilities[answer] ?? 0;
    return {
      key,
      kind: 'minProbability',
      value: minProbability,
      gap: round(p - minProbability, 3),
    };
  }
  if (minConfidence !== undefined) {
    return {
      key,
      kind: 'minConfidence',
      value: minConfidence,
      gap: round(given.confidence - minConfidence, 3),
    };
  }
  return undefined;
}

function changedSince(record: ShadowRecord, policy: Policy | undefined): boolean | null {
  if (record.rulesHash === undefined || policy === undefined) {
    return null;
  }
  return rulesHash(policy) !== record.rulesHash;
}

function ruleView(
  record: ShadowRecord,
  policy: Policy | undefined,
  matched: PolicyRule | undefined,
): ExplainRule | undefined {
  if (record.rule === undefined) {
    return undefined;
  }
  const changedSinceDecision = changedSince(record, policy);
  if (policy === undefined) {
    return { index: record.rule, changedSinceDecision };
  }
  if (record.rule < 0) {
    return { index: -1, action: policy.default, changedSinceDecision };
  }
  if (matched === undefined) {
    return { index: record.rule, changedSinceDecision };
  }
  const threshold = thresholdView(matched, record.answers);
  return {
    index: record.rule,
    action: matched.action,
    when: matched.when,
    ...(threshold === undefined ? {} : { threshold }),
    changedSinceDecision,
  };
}

function outcomeView(o: OutcomeRecord): ExplainOutcome {
  return {
    ts: o.ts,
    outcome: o.outcome,
    source: o.source,
    verified: isVerifiedOutcome(o),
    ...(o.claimedSource === undefined ? {} : { claimedSource: o.claimedSource }),
  };
}

/** The outcome in force: the verified ones folded in order, as precedent folds them. */
function effectiveOutcome(outcomes: readonly OutcomeRecord[]): string | undefined {
  let current: string | undefined;
  for (const o of outcomes.filter(isVerifiedOutcome)) {
    current = correctedOutcome(current, o.outcome) ?? current;
  }
  return current;
}

/** Verified usage only: unverified rows are display-only elsewhere and could be forged. */
function usageView(usage: readonly UsageRecord[]): ExplainUsage | undefined {
  const seen = new Set<string>();
  const rows = usage.filter((u) => {
    if (u.verified !== true) {
      return false;
    }
    if (u.turnId === undefined) {
      return true;
    }
    const fresh = !seen.has(u.turnId);
    seen.add(u.turnId);
    return fresh;
  });
  if (rows.length === 0) {
    return undefined;
  }
  const costs = rows.flatMap((u) => (u.costUsd === undefined ? [] : [u.costUsd]));
  return {
    turns: rows.length,
    inputTokens: rows.reduce((n, u) => n + u.inputTokens, 0),
    cachedInputTokens: rows.reduce((n, u) => n + u.cachedInputTokens, 0),
    outputTokens: rows.reduce((n, u) => n + u.outputTokens, 0),
    ...(costs.length === 0 ? {} : { costUsd: costs.reduce((n, c) => n + c, 0) }),
  };
}

/** First line, cut, with control characters (terminal escapes) dropped: errors are not trusted. */
function firstLine(error: string): string {
  const [first = ''] = error.split('\n');
  const line = first.replaceAll(/\p{Cc}/gu, '');
  return line.length > ERROR_CHARS ? `${line.slice(0, ERROR_CHARS - 1)}…` : line;
}

function identity(record: ShadowRecord): Partial<ExplainView> {
  return {
    ...(record.variant === undefined ? {} : { variant: record.variant }),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.callId === undefined ? {} : { callId: record.callId }),
    ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }),
    ...(record.subagent === undefined ? {} : { subagent: record.subagent }),
    ...(record.tool === undefined ? {} : { tool: record.tool }),
    ...(record.cached === undefined ? {} : { cached: record.cached }),
  };
}

function recorded(record: ShadowRecord): Partial<ExplainView> {
  return {
    ...(record.precedent === undefined
      ? {}
      : {
          precedent: {
            allows: record.precedent.allows,
            denies: record.precedent.denies,
            ...(record.precedentKey === undefined ? {} : { key: record.precedentKey.slice(0, 12) }),
          },
        }),
    ...(record.redactions === undefined ? {} : { redactions: record.redactions }),
    ...(record.truncated === undefined || record.truncated.length === 0
      ? {}
      : { truncated: record.truncated }),
    ...(record.queueMs === undefined ? {} : { queueMs: record.queueMs }),
    ...(record.engineMs === undefined ? {} : { engineMs: record.engineMs }),
    ...(record.stateTokens === undefined ? {} : { stateTokens: record.stateTokens }),
    ...(record.error === undefined ? {} : { error: firstLine(record.error) }),
  };
}

/** Pure: one stored decision, its outcomes and usage, and the policies now in force. */
export function explainDecision(
  record: ShadowRecord,
  outcomes: readonly OutcomeRecord[],
  usage: readonly UsageRecord[],
  context: ExplainContext,
): ExplainView {
  const policy = effectivePolicy(record, context);
  const matched = record.rule === undefined ? undefined : policy?.rules[record.rule];
  const primary = primaryFor(record, policy);
  const rule = ruleView(record, policy, matched);
  const effective = effectiveOutcome(outcomes);
  const used = usageView(usage);
  return {
    decisionId: record.decisionId,
    ts: record.ts,
    policy: record.policy,
    harness: record.harness,
    mode: record.mode,
    action: record.action,
    enforced: record.enforced,
    answers: answersView(record.answers),
    engine: record.engine,
    model: record.model,
    latencyMs: record.latencyMs,
    outcomes: outcomes.map(outcomeView),
    inputHash: record.inputHash.slice(0, 12),
    ...identity(record),
    ...recorded(record),
    ...(primary === undefined ? {} : { primary }),
    ...(rule === undefined ? {} : { rule }),
    ...(effective === undefined ? {} : { effectiveOutcome: effective }),
    ...(used === undefined ? {} : { usage: used }),
  };
}

/** The projection for anything an agent can call; never more than the reason text shows. */
export function agentView(view: ExplainView): AgentView {
  const { primary } = view;
  return {
    decisionId: view.decisionId,
    policy: view.policy,
    action: view.action,
    enforced: view.enforced,
    ...(primary === undefined
      ? {}
      : {
          primary: {
            question: primary.question,
            answer: primary.answer,
            confidence: round(primary.confidence, 2),
          },
        }),
    failedOpen: view.error !== undefined,
    truncated: view.truncated !== undefined,
  };
}

const NOT_RECORDED = 'not recorded (before F6)';
const stamp = (ts: string): string => `${ts.slice(0, 10)} ${ts.slice(11, 19)}Z`;
const clock = (ts: string): string => `${ts.slice(11, 19)}Z`;
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

function headerLines(view: ExplainView): string[] {
  const where = [view.harness, view.scope, view.tool].filter((x) => x !== undefined).join(' · ');
  const verdict = view.enforced ? 'enforced' : 'not enforced';
  const cached = view.cached === undefined ? '' : ` · cached ${view.cached ? 'yes' : 'no'}`;
  return [
    `decision ${view.decisionId}  ${view.policy}  ${stamp(view.ts)}  ${where}`,
    `mode ${view.mode} · ${view.action} (${verdict})${cached}`,
  ];
}

function verdictLines(view: ExplainView): string[] {
  const asked = view.primary?.question;
  const questions = Object.keys(view.answers).toSorted(
    (a, b) => Number(b === asked) - Number(a === asked),
  );
  return questions.map((question) => {
    const entry = view.answers[question];
    const probs = Object.entries(entry?.probabilities ?? {})
      .toSorted(([, a], [, b]) => b - a)
      .map(([name, p]) => `${name} ${p.toFixed(2)}`)
      .join(' · ');
    const extra =
      question === asked && view.primary ? ` (margin ${view.primary.margin.toFixed(2)})` : '';
    return `${question}: ${probs}${extra}`;
  });
}

function ruleText(rule: ExplainRule): string {
  const target = rule.index < 0 ? 'default' : `#${String(rule.index)}`;
  const action = rule.action === undefined ? '' : ` → ${rule.action}`;
  const when = rule.when === undefined ? '' : ` when ${whenText(rule.when)}`;
  return `${target}${action}${when}`;
}

function whenText(when: PolicyRule['when']): string {
  const bound =
    when.minProbability === undefined
      ? when.minConfidence === undefined
        ? ''
        : ` (confidence ≥ ${String(when.minConfidence)})`
      : ` ≥ ${String(when.minProbability)}`;
  const precedent = when.precedent === undefined ? '' : ' with allow precedent';
  return `${when.question}.${when.answer}${bound}${precedent}`;
}

function ruleLine(view: ExplainView): string {
  const { rule } = view;
  if (rule === undefined) {
    return `rule: ${NOT_RECORDED}`;
  }
  const gap =
    rule.threshold === undefined
      ? ''
      : ` (${rule.threshold.kind === 'minProbability' ? 'p' : 'confidence'} gap ${signed(rule.threshold.gap)})`;
  const changed = {
    true: '; rules changed since the decision, so this index may point at another rule',
    false: '; rules and thresholds unchanged since',
    null: '',
  }[String(rule.changedSinceDecision) as 'true' | 'false' | 'null'];
  return `rule: ${ruleText(rule)}${gap}${changed}`;
}

function detailLines(view: ExplainView): string[] {
  const lines: string[] = [];
  lines.push(ruleLine(view));
  lines.push(
    view.precedent === undefined
      ? `precedent: ${NOT_RECORDED}`
      : `precedent: ${String(view.precedent.allows)} allows · ${String(view.precedent.denies)} denies${view.precedent.key === undefined ? '' : ` (key ${view.precedent.key})`}`,
  );
  const redactions = Object.entries(view.redactions ?? {});
  if (redactions.length > 0) {
    lines.push(`redactions: ${redactions.map(([kind, n]) => `${kind} ${String(n)}`).join(' · ')}`);
  }
  if (view.truncated !== undefined) {
    lines.push(`truncated: ${view.truncated.join(', ')}`);
  }
  if (view.error !== undefined) {
    lines.push(`error: ${view.error} (failed open)`);
  }
  return lines;
}

function engineLine(view: ExplainView): string {
  const timing = [
    view.queueMs === undefined ? undefined : `queue ${String(view.queueMs)}`,
    view.engineMs === undefined ? undefined : `engine ${String(view.engineMs)}`,
  ].filter((x) => x !== undefined);
  const parts = [
    `engine ${view.engine} ${view.model} · ${String(view.latencyMs)} ms${timing.length === 0 ? '' : ` (${timing.join(', ')})`}`,
  ];
  if (view.stateTokens !== undefined) {
    parts.push(`state ≈ ${String(view.stateTokens)} tokens`);
  }
  return parts.join(' · ');
}

function outcomeLines(view: ExplainView): string[] {
  const rows = view.outcomes.map((o) => {
    const claimed = o.claimedSource === undefined ? '' : `, claimed ${o.claimedSource}`;
    return `${clock(o.ts)} ${o.outcome} (${o.source}, ${o.verified ? 'verified' : 'unverified'}${claimed})`;
  });
  const lines = [`outcomes: ${rows.length === 0 ? 'none' : rows.join(' · ')}`];
  if (view.effectiveOutcome !== undefined) {
    lines.push(`effective outcome: ${view.effectiveOutcome} (verified labels only)`);
  }
  if (view.usage !== undefined) {
    const cost = view.usage.costUsd === undefined ? '' : ` · $${view.usage.costUsd.toFixed(4)}`;
    lines.push(
      `usage: ${String(view.usage.turns)} turns · ${String(view.usage.inputTokens)} in (${String(view.usage.cachedInputTokens)} cached) · ${String(view.usage.outputTokens)} out${cost}`,
    );
  }
  return lines;
}

/** One fact per line; vocabulary shared with the reason text (`verdict`, `rule`, `precedent`). */
export function formatExplain(view: ExplainView): string {
  return [
    ...headerLines(view),
    ...verdictLines(view),
    ...detailLines(view),
    engineLine(view),
    ...outcomeLines(view),
    `label: local-decider label ${view.decisionId} unsafe`,
    'find the call: search the session transcript for this decision id',
  ].join('\n');
}
