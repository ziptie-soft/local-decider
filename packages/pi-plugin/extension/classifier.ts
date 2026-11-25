/**
 * pi decision-model provider `local-decider`: one classifier model, `active`, which is whatever
 * engine the gateway is running. `classify()` posts `{ state, questions }` to `/v1/systemone`
 * (no `model`, so the gateway uses its active engine), with pi's `bool` questions sent as the
 * wire's `noul` and mapped back. Every path returns a complete `ClassifierResult`; it never throws.
 *
 * Auth: pi's provider composer needs a configured auth method (pi v1.6.1
 * `packages/coding-agent/src/core/provider-composer.ts:581`). A literal `apiKey` with no `$` or
 * `!` counts as configured with no env lookup (provider-composer.ts:394-399, 451-457;
 * resolve-config-value.ts:121-131), and `authHeader: false` (the default, :435) keeps it out of
 * any header (:380-391). The key is a fixed, non-secret placeholder that pi never sends anywhere:
 * the classifier calls the gateway through the extension's own client, with the extension's token.
 */

import type { Gateway } from './gateway.ts';
import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierQuestion,
  ClassifierResult,
  PiAPI,
  PiClassifierModelConfig,
  PiProviderClassifier,
  PiProviderConfig,
  Usage,
} from './pi-types.ts';

export const PROVIDER_ID = 'local-decider';
export const CLASSIFIER_API = 'local-decider-systemone';
const MODEL_ID = 'active';
/** Not a secret: satisfies pi's auth check and is never sent (see the file comment). */
export const PLACEHOLDER_API_KEY = 'local-decider-no-key';
/** The engine may be cold or busy; pi's own caller signal can cut this short. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 30_000;

export interface ClassifierDeps {
  readonly gateway: Gateway;
  /** Gateway URL; informational in pi's model list, pi's transport never calls it. */
  readonly url: string;
  readonly timeoutMs?: number;
}

type Answers = Record<string, ClassifierAnswer>;
type Parsed = { readonly answers: Answers } | { readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

function wireQuestion(question: ClassifierQuestion): Record<string, unknown> {
  const { instructions, criteria } = question;
  if (question.type === 'bool') {
    return {
      type: 'noul',
      instructions,
      criteria: { true: question.criteria.true, false: question.criteria.false },
    };
  }
  return { type: question.type, instructions, criteria };
}

function wireRequest(context: ClassifierContext): Record<string, unknown> {
  const questions = Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => [id, wireQuestion(question)]),
  );
  return { state: context.state, questions };
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/** Every value a probability, at least one entry; else undefined. */
function probabilityMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [key, p] of entries) {
    if (!isProbability(p)) return undefined;
    out[key] = p;
  }
  return out;
}

/** Strands' choice confidence (N·p_max − 1)/(N − 1) over the question's N options. */
function choiceConfidence(probabilities: Record<string, number>, options: number): number {
  if (options < 2) return 1;
  const pMax = Math.max(...Object.values(probabilities));
  return clamp01((options * pMax - 1) / (options - 1));
}

/** Strands' score confidence (σ_max − σ)/σ_max over level indices `"0"`..`"n-1"`. */
function scoreConfidence(probabilities: Record<string, number>, levels: number): number {
  if (levels < 2) return 1;
  const byIndex = Array.from({ length: levels }, (_, i) => probabilities[String(i)] ?? 0);
  const mean = byIndex.reduce((acc, p, i) => acc + p * i, 0);
  const variance = byIndex.reduce((acc, p, i) => acc + p * (i - mean) ** 2, 0);
  const sigmaMax = (levels - 1) / 2;
  return clamp01((sigmaMax - Math.sqrt(variance)) / sigmaMax);
}

function choiceAnswer(
  wire: Record<string, unknown>,
  criteria: Record<string, string>,
): ClassifierAnswer | string {
  const choice = wire['choice'];
  if (typeof choice !== 'string' || !Object.hasOwn(criteria, choice)) return 'an unknown choice';
  const probabilities = probabilityMap(wire['probabilities']);
  if (probabilities === undefined) return 'malformed probabilities';
  const given = wire['confidence'];
  if (given !== undefined && !isProbability(given)) return 'a malformed confidence';
  const confidence = given ?? choiceConfidence(probabilities, Object.keys(criteria).length);
  return { type: 'choice', choice, probabilities, confidence };
}

function scoreAnswer(wire: Record<string, unknown>, levels: number): ClassifierAnswer | string {
  const score = wire['score'];
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels - 1) {
    return 'a malformed score';
  }
  const given = wire['confidence'];
  if (isProbability(given)) return { type: 'score', score, confidence: given };
  if (given !== undefined) return 'a malformed confidence';
  const probabilities = probabilityMap(wire['probabilities']);
  if (probabilities === undefined) return 'no confidence or probabilities';
  return { type: 'score', score, confidence: scoreConfidence(probabilities, levels) };
}

/** p(true) from `probabilities.true` when present, else from `noul` (a number, or a boolean as 1/0). */
function boolAnswer(wire: Record<string, unknown>): ClassifierAnswer | string {
  const probabilities = wire['probabilities'];
  if (isRecord(probabilities) && probabilities['true'] !== undefined) {
    const p = probabilities['true'];
    return isProbability(p) ? { type: 'bool', probability: p } : 'a malformed probability';
  }
  const noul = wire['noul'];
  if (typeof noul === 'boolean') return { type: 'bool', probability: noul ? 1 : 0 };
  return isProbability(noul) ? { type: 'bool', probability: noul } : 'a malformed probability';
}

const WIRE_TYPE = { bool: 'noul', choice: 'choice', score: 'score' } as const;

function mapAnswer(question: ClassifierQuestion, wire: unknown): ClassifierAnswer | string {
  if (!isRecord(wire)) return 'no answer';
  if (wire['type'] !== WIRE_TYPE[question.type]) return `a ${String(wire['type'])} answer`;
  if (question.type === 'choice') return choiceAnswer(wire, question.criteria);
  if (question.type === 'score') return scoreAnswer(wire, question.criteria.length);
  return boolAnswer(wire);
}

function parseAnswers(context: ClassifierContext, reply: unknown): Parsed {
  if (!isRecord(reply) || !isRecord(reply['answers'])) {
    return { error: 'local-decider gateway returned an unexpected response' };
  }
  const wire = reply['answers'];
  const answers: Answers = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = mapAnswer(question, wire[id]);
    if (typeof answer === 'string') {
      return { error: `local-decider gateway returned ${answer} for ${id}` };
    }
    answers[id] = answer;
  }
  return { answers };
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** A complete pi `Usage` from the wire's `{ input_tokens, output_tokens }`, at zero cost. */
function usageOf(reply: unknown): Usage {
  const raw = isRecord(reply) && isRecord(reply['usage']) ? reply['usage'] : {};
  const input = tokens(raw['input_tokens']);
  const output = tokens(raw['output_tokens']);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseResult(model: ClassifierModel): ClassifierResult {
  return {
    api: model.api,
    provider: PROVIDER_ID,
    model: model.id,
    answers: {},
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** A function, not an inline check, so the compiler does not narrow it across an `await`. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function failed(
  result: ClassifierResult,
  errorMessage: string,
  signal: AbortSignal | undefined,
): ClassifierResult {
  return {
    ...result,
    answers: {},
    stopReason: aborted(signal) ? 'aborted' : 'error',
    errorMessage,
  };
}

async function classify(
  gateway: Gateway,
  timeoutMs: number,
  model: ClassifierModel,
  context: ClassifierContext,
  options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
  const result = baseResult(model);
  const signal = options?.signal;
  if (context.images !== undefined && context.images.length > 0) {
    return failed(result, 'local-decider does not support image input', undefined);
  }
  if (aborted(signal)) return failed(result, 'local-decider request aborted', signal);
  const reply = await gateway.systemOne(wireRequest(context), { timeoutMs, signal });
  // The gateway client resolves null on abort too; the signal tells the two apart.
  if (aborted(signal)) return failed(result, 'local-decider request aborted', signal);
  if (reply === null) return failed(result, 'local-decider gateway unavailable', undefined);
  const parsed = parseAnswers(context, reply);
  const usage = usageOf(reply);
  if ('error' in parsed) return { ...failed(result, parsed.error, undefined), usage };
  return { ...result, answers: parsed.answers, usage };
}

/** The `classifiers[CLASSIFIER_API]` entry. Never throws, never rejects. */
export function createClassifier(
  gateway: Gateway,
  timeoutMs: number = DEFAULT_CLASSIFY_TIMEOUT_MS,
): PiProviderClassifier {
  return {
    async classify(model, context, options) {
      try {
        return await classify(gateway, timeoutMs, model, context, options);
      } catch {
        return failed(baseResult(model), 'local-decider classifier failed', options?.signal);
      }
    },
  };
}

function classifierModel(): PiClassifierModelConfig {
  return {
    type: 'classifier',
    id: MODEL_ID,
    name: 'local-decider (active engine)',
    api: CLASSIFIER_API,
    input: ['text'],
    contextWindow: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function providerConfig(deps: ClassifierDeps): PiProviderConfig {
  return {
    name: 'local-decider',
    baseUrl: deps.url,
    apiKey: PLACEHOLDER_API_KEY,
    authHeader: false,
    models: [classifierModel()],
    classifiers: { [CLASSIFIER_API]: createClassifier(deps.gateway, deps.timeoutMs) },
  };
}

/** Registers the provider. No network I/O. */
export function registerClassifier(pi: PiAPI, deps: ClassifierDeps): void {
  pi.registerProvider(PROVIDER_ID, providerConfig(deps));
}
