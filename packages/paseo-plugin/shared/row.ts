/** The plugin's timeline row: one compact decision, drawn by `client/decision-row.tsx`. */
import { z } from 'zod';

import { MCP_SERVER_NAME, type RowVisibility } from './constants.ts';
import type { Answer, DecideResponse, Mode } from './decision.ts';
import { shortModel } from './models.ts';
import { thresholdText, type ThresholdSetting } from './policies.ts';

const MAX_OPTIONS = 12;
/** Below this confidence a shadow row counts as notable. */
const LOW_CONFIDENCE = 0.7;
/** Below this confidence the summary says `unsure` instead of presenting the answer. */
const UNSURE_CONFIDENCE = 0.5;

/** Permission-row labels (ADR-0006 addendum): only `unsafe` is reported, as a veto. */
export const LABEL_CHOICES = ['safe', 'unsafe', 'skip'] as const;
export type LabelChoice = (typeof LABEL_CHOICES)[number];
/** What a permission row can be labelled as. */
export type LabelKind = 'declined' | 'interrupted' | 'auto-allowed';
/** Label chips stay actionable this long after the answer or auto-allow (gateway replays 25 h). */
export const LABEL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Why a permission was left to the user without a decision. */
export const SKIP_REASONS = ['busy', 'rate-limit', 'deadline', 'no-answer'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const decisionRowSchema = z.object({
  decisionId: z.string(),
  policy: z.string(),
  source: z.enum(['turn', 'permission', 'manual', 'routing']),
  /** Primary answer and its confidence, if the engine answered. */
  question: z.string(),
  answer: z.string(),
  confidence: z.number(),
  action: z.string(),
  gatewayMode: z.enum(['off', 'shadow', 'act']),
  /** Gateway said enforced AND the plugin's own mode for this policy is `act`. */
  enforced: z.boolean(),
  /** The plugin changed something (e.g. allowed the permission). */
  applied: z.boolean(),
  /** Enforced `notify`: surface it. */
  attention: z.boolean(),
  engine: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  cached: z.boolean(),
  error: z.string().nullable(),
  note: z.string().nullable(),
  /** The row's own timeline id, so feedback can replace it. '' on rows from older versions. */
  rowId: z.string().max(200).default(''),
  /** Options of the primary question, offered as feedback. */
  options: z.array(z.string().max(100)).max(MAX_OPTIONS).default([]),
  /** The answer the user reported as right. */
  feedback: z.string().max(100).nullable().default(null),
  /**
   * Epoch ms (daemon clock) of the user's answer or our auto-allow. Null: no label chips. Display
   * hint only: the daemon never trusts it from a client.
   */
  answeredAt: z.number().int().nonnegative().nullable().default(null),
  /** The decision had a precedent key, so an `unsafe` label can veto its subject. */
  vetoable: z.boolean().default(false),
  /** The user's label on a permission row, once given. */
  label: z.enum(LABEL_CHOICES).nullable().default(null),
  /** The primary question's probabilities (3 dp, at most `MAX_OPTIONS`), for the expanded row. */
  probabilities: z.record(z.string().max(100), z.number()).default({}),
  /** Index of the first matching rule; -1 is the policy default. */
  rule: z.number().int().default(-1),
  /** Exact-match precedent tally the decision used, when configured. */
  precedent: z
    .object({ allows: z.number().int().nonnegative(), denies: z.number().int().nonnegative() })
    .nullable()
    .default(null),
  variant: z.string().max(100).nullable().default(null),
  /** Some state sections were cut before the engine saw them. */
  truncated: z.boolean().default(false),
  /** The plugin's own mode for this policy when the row was drawn. */
  pluginMode: z.enum(['off', 'shadow', 'act']).nullable().default(null),
  /** `pending` and `skipped` rows are placeholders without a decision (`placeholderRow`). */
  state: z.enum(['decided', 'pending', 'skipped']).default('decided'),
  reason: z.enum(SKIP_REASONS).nullable().default(null),
});

export type DecisionRow = z.output<typeof decisionRowSchema>;

/** The policy's first question in policy order, which is the one the rules key on. */
function primaryAnswer(res: DecideResponse): [string, Answer] | null {
  const first = Object.entries(res.answers)[0];
  return first ?? null;
}

export interface RowContext {
  readonly source: DecisionRow['source'];
  /** Stable subject key: turn, permission request or decision id. */
  readonly key: string;
  readonly enforced: boolean;
  readonly applied?: boolean;
  readonly note?: string;
  /** The plugin's mode for the policy, to flag a plugin `act` the gateway did not enforce. */
  readonly pluginMode?: Mode;
}

function gatewayMode(mode: Mode | undefined): DecisionRow['gatewayMode'] {
  return mode === 'act' || mode === 'off' ? mode : 'shadow';
}

/** The explanation fields: probabilities, rule, precedent, variant, truncation. */
function explainFields(
  res: DecideResponse,
  primary: [string, Answer] | null,
): Pick<DecisionRow, 'probabilities' | 'rule' | 'precedent' | 'variant' | 'truncated'> {
  const entries = Object.entries(primary?.[1].probabilities ?? {}).slice(0, MAX_OPTIONS);
  return {
    probabilities: Object.fromEntries(
      entries.map(([key, p]) => [key, Math.round((Number.isFinite(p) ? p : 0) * 1000) / 1000]),
    ),
    rule: Number.isInteger(res.rule) ? res.rule : -1,
    precedent:
      res.precedent === undefined
        ? null
        : { allows: res.precedent.allows, denies: res.precedent.denies },
    variant: res.variant?.slice(0, 100) ?? null,
    truncated: (res.truncated?.length ?? 0) > 0,
  };
}

export function toRowData(res: DecideResponse, ctx: RowContext): DecisionRow {
  const primary = primaryAnswer(res);
  return {
    ...explainFields(res, primary),
    pluginMode: ctx.pluginMode ?? null,
    state: 'decided',
    reason: null,
    decisionId: res.decisionId,
    policy: res.policy,
    source: ctx.source,
    question: primary?.[0] ?? '',
    answer: primary?.[1].answer ?? '',
    confidence: primary?.[1].confidence ?? 0,
    action: res.action,
    gatewayMode: gatewayMode(res.mode),
    enforced: ctx.enforced,
    applied: ctx.applied ?? false,
    attention: ctx.enforced && res.action === 'notify',
    engine: res.engine,
    model: res.model,
    latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : 0,
    cached: res.cached,
    error: typeof res.error === 'string' ? res.error.slice(0, 300) : null,
    note: ctx.note ?? null,
    rowId: rowId(ctx.source, ctx.key),
    options: Object.keys(primary?.[1].probabilities ?? {}).slice(0, MAX_OPTIONS),
    feedback: null,
    answeredAt: null,
    vetoable: res.precedentKey !== undefined,
    label: null,
  };
}

/**
 * Whether a row is appended under the user's chat-row setting. `notable` keeps rows that changed
 * something, need attention or failed, plus unsure rows only while not enforced (shadow), where
 * they help calibration. A routine enforced row (e.g. `log` after every turn in act) is hidden.
 */
export function rowVisible(row: DecisionRow, show: RowVisibility): boolean {
  if (row.source === 'manual' || show === 'all') {
    return true;
  }
  if (show === 'off') {
    return false;
  }
  return (
    row.applied ||
    row.attention ||
    row.error !== null ||
    (!row.enforced && row.answer !== '' && row.confidence < LOW_CONFIDENCE)
  );
}

/** Row ids are stable per subject, so re-appending replaces the row. */
export function rowId(source: DecisionRow['source'], key: string): string {
  return `${MCP_SERVER_NAME}-${source}-${key}`;
}

function percent(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** The model's answer, never presented as the answer when weak: `leaned done 80%`, `unsure 40%`. */
function leaning(row: DecisionRow): string {
  if (row.answer === '') {
    return 'no answer';
  }
  const pct = percent(row.confidence);
  return row.confidence < UNSURE_CONFIDENCE ? `unsure ${pct}` : `leaned ${row.answer} ${pct}`;
}

/** What happened: permission rows say whether we allowed or left it to the user. */
function outcome(row: DecisionRow): string {
  if (row.source === 'routing') {
    return row.note ?? row.action;
  }
  if (row.source !== 'permission') {
    return row.action;
  }
  if (row.applied) {
    return 'auto-allowed';
  }
  return !row.enforced && row.action === 'allow' ? 'asked you · would auto-allow' : 'asked you';
}

function modeLabel(row: DecisionRow): string {
  if (row.enforced) {
    return 'act';
  }
  if (row.gatewayMode === 'act') {
    return 'act (plugin: shadow)';
  }
  // The plugin would act but the gateway did not enforce (a YAML edit, a failed write, a retune).
  if (row.pluginMode === 'act' && row.error === null) {
    return `act (gateway: ${row.gatewayMode})`;
  }
  return row.gatewayMode;
}

const SKIP_TEXT: Readonly<Record<Exclude<SkipReason, 'no-answer'>, string>> = {
  'busy': 'skipped: busy',
  'rate-limit': 'skipped: rate limit',
  'deadline': 'skipped: out of time',
};

/** `permission · deciding… · act`, `permission · skipped: busy · answer it yourself`. */
function placeholderSummary(row: DecisionRow): string {
  if (row.state === 'pending') {
    return `${row.policy} · deciding… · ${modeLabel(row)}`;
  }
  const what =
    row.reason === null || row.reason === 'no-answer' ? 'not decided' : SKIP_TEXT[row.reason];
  return `${row.policy} · ${what} · answer it yourself`;
}

/**
 * A row without a decision: `pending` while a slow decision runs, `skipped` when the request was
 * left to the user. Same row id as the decided row, so that replaces it in place.
 */
export function placeholderRow(
  source: DecisionRow['source'],
  key: string,
  policy: string,
  state: 'pending' | 'skipped',
  reason: SkipReason | null = null,
): DecisionRow {
  return decisionRowSchema.parse({
    decisionId: '',
    policy,
    source,
    question: '',
    answer: '',
    confidence: 0,
    action: 'ask',
    gatewayMode: 'act',
    enforced: true,
    applied: false,
    attention: false,
    engine: '',
    model: '',
    latencyMs: 0,
    cached: false,
    error: null,
    note: null,
    rowId: rowId(source, key),
    pluginMode: 'act',
    state,
    reason,
  });
}

/**
 * One line, what happened first: `permission · asked you · leaned allow 72% · act`,
 * `turn-outcome · notify · leaned needs_input 82% · shadow`.
 */
export function rowSummary(row: DecisionRow): string {
  if (row.state !== 'decided') {
    return placeholderSummary(row);
  }
  return `${row.policy} · ${outcome(row)} · ${leaning(row)} · ${modeLabel(row)}`;
}

export function rowDetail(row: DecisionRow): string {
  const parts = [
    shortModel(row.model),
    `${Math.round(row.latencyMs)} ms${row.cached ? ' cached' : ''}`,
  ];
  if (row.note !== null) {
    parts.unshift(row.note);
  }
  if (row.error !== null) {
    parts.push(`engine error: ${row.error}`);
  }
  return parts.filter((p) => p !== '').join(' · ');
}

const EXPLAIN_TOP = 6;

/** `allow 0.78 · deny 0.15 · unsure 0.07`, highest first, at most six. */
function verdictLine(probabilities: DecisionRow['probabilities']): string | null {
  const sorted = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return null;
  }
  const shown = sorted.slice(0, EXPLAIN_TOP).map(([key, p]) => `${key} ${p.toFixed(2)}`);
  return `verdict: ${shown.join(' · ')}${sorted.length > EXPLAIN_TOP ? ' · …' : ''}`;
}

function ruleLine(row: DecisionRow): string {
  return row.rule < 0
    ? `rule: none matched → default ${row.action}`
    : `rule: #${String(row.rule)} matched → ${row.action}`;
}

/** `thresholds now: allow at p(allow) ≥ 0.85`; null when unknown (the RPC failed) or none apply. */
function thresholdLine(
  row: DecisionRow,
  thresholds: readonly ThresholdSetting[] | null,
): string | null {
  const own = (thresholds ?? []).filter((t) => t.question === row.question);
  if (own.length === 0) {
    return null;
  }
  return `thresholds now: ${own.map((t) => `${t.action} at ${thresholdText(t)}`).join(' · ')}`;
}

/**
 * The lines an expanded row shows: why the decider answered as it did. The thresholds are the
 * ones in force now, not at decision time (they can be retuned), hence "now".
 */
export function rowExplain(
  row: DecisionRow,
  thresholds: readonly ThresholdSetting[] | null,
): readonly string[] {
  const tally = row.precedent;
  return [
    verdictLine(row.probabilities),
    ruleLine(row),
    thresholdLine(row, thresholds),
    tally === null
      ? null
      : `precedent: ${plural(tally.allows, 'allow')} · ${plural(tally.denies, 'deny', 'denies')}`,
    row.variant === null ? null : `variant: ${row.variant}`,
    row.truncated ? 'input truncated' : null,
    rowDetail(row),
  ].filter((line): line is string => line !== null && line !== '');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The label kind of a row the daemon drew, or null when it offers no label chips. */
export function rowLabelKind(row: DecisionRow): LabelKind | null {
  if (row.source !== 'permission' || row.answeredAt === null) {
    return null;
  }
  if (row.feedback === 'decline') {
    return 'declined';
  }
  if (row.feedback === 'interrupted') {
    return 'interrupted';
  }
  return row.applied && row.feedback === null && row.vetoable ? 'auto-allowed' : null;
}

/** The chips a label kind offers. */
export function choicesFor(kind: LabelKind): readonly LabelChoice[] {
  return kind === 'auto-allowed' ? ['unsafe'] : LABEL_CHOICES;
}

/** True once the label window has passed (the client hides chips; the daemon rejects taps). */
export function labelExpired(answeredAt: number, now: number): boolean {
  return now - answeredAt > LABEL_WINDOW_MS;
}

/** Best-effort chips for the client to render now; the daemon decides on a tap. */
export function labelChoices(row: DecisionRow, now: number): readonly LabelChoice[] {
  const kind = rowLabelKind(row);
  if (kind === null || row.label !== null || row.answeredAt === null) {
    return [];
  }
  return labelExpired(row.answeredAt, now) ? [] : choicesFor(kind);
}

/** The outcome a label reports to the gateway; null reports nothing. */
export function labelOutcome(label: LabelChoice): string | null {
  return label === 'unsafe' ? 'unsafe' : null;
}

const MARKED_UNSAFE =
  '✗ Marked unsafe · past allows no longer lower the threshold; high-confidence rules may still allow it';

function declineNote(row: DecisionRow, feedback: 'decline' | 'interrupted'): string {
  const base = feedback === 'decline' ? '✗ You declined' : '■ You stopped the agent';
  if (row.label === 'safe') {
    return `${base} · not a safety issue`;
  }
  return row.label === 'unsafe' ? `${base} · marked unsafe` : base;
}

/** The permission row's answer line, or null while unanswered. */
export function permissionNote(row: DecisionRow): string | null {
  const { feedback } = row;
  if (row.applied && row.label === 'unsafe') {
    return MARKED_UNSAFE;
  }
  if (feedback === null) {
    return null;
  }
  if (feedback === 'allow') {
    return '✓ You allowed';
  }
  if (feedback === 'decline' || feedback === 'interrupted') {
    return declineNote(row, feedback);
  }
  return feedback === 'deny' ? '✗ You denied' : `You answered: ${feedback}`;
}
