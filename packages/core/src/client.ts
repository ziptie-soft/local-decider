/**
 * Minimal gateway client for harness adapters. Every call has a hard timeout and returns `null`
 * instead of throwing, so callers fail open to the harness's default behaviour.
 */
import type { DecideRequest, DecideResponse } from './decision.ts';
import { asRecord } from './subject.ts';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';
export const CONTROL_HEADER = 'x-local-decider-control';
export const CLIENT_HEADER = 'x-local-decider-client';

/** `value` without trailing `/`. A loop, not `/\/+$/`, which backtracks quadratically on long runs. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway. Read from the environment by the caller; never logged. */
  readonly token?: string;
  /** Local control token. Sent only when `baseUrl` points to loopback. */
  readonly controlToken?: string | undefined;
  readonly fetch?: typeof fetch;
  /** Informational client identity, such as `claude-hooks/1.0.0`. */
  readonly clientId?: string;
}

export interface GatewayHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly version?: string;
  readonly instance?: string;
  readonly engine?: string;
  readonly model?: string;
  /** `stopped|starting|ready|failed`; `detail` says why it is not ready. */
  readonly engineState?: string;
  readonly detail?: string;
  readonly p50Ms?: number;
}

export interface EngineSelectionRequest {
  readonly engine: string;
  readonly model: string;
  readonly device?: string;
}

/** A model for one decision (policy), as `POST /v1/policies/:id/selection` takes it. */
export interface PolicySelectionRequest {
  readonly engine: string;
  readonly model: string;
  readonly device?: string;
  /** What answers while the model cannot: the default model, or nothing (`open`). */
  readonly fallback?: 'default' | 'open';
}

export interface GatewayRequestResult {
  readonly status: number;
  readonly body: unknown;
}

const LOOPBACK = new Set(['localhost', '[::1]', '::1']);
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Keep in step with the action grammar in policy.ts without pulling the policy parser into hooks.
const ACTION = /^(?:allow|ask|deny|log|abstain|notify|route:[a-z0-9][a-z0-9_.-]*)$/;
const DECISION_ID = /^[\w-]{1,128}$/;
// Match the tolerance used when normalising engine answers in systemone.ts.
const PROBABILITY_SUM_TOLERANCE = 0.05;

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function unitNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validAnswerProbabilities(values: Record<string, unknown>): boolean {
  const entries = Object.entries(values);
  if (entries.length < 2) return false;
  let sum = 0;
  for (const [key, value] of entries) {
    if (
      key.trim() === '' ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      return false;
    }
    sum += value;
  }
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function validAnswerSemantics(
  answer: Record<string, unknown>,
  probabilities: Record<string, unknown>,
): boolean {
  const type = answer['type'];
  const selected = answer['answer'];
  if (typeof selected !== 'string' || !Object.hasOwn(probabilities, selected)) return false;
  const selectedProbability = probabilities[selected] as number;
  if (Object.values(probabilities).some((p) => (p as number) > selectedProbability)) return false;
  if (type === 'noul') {
    const pTrue = probabilities['true'];
    return (
      Object.keys(probabilities).length === 2 &&
      typeof pTrue === 'number' &&
      Object.hasOwn(probabilities, 'false') &&
      selected === (pTrue > 0.5 ? 'true' : 'false') &&
      answer['score'] === undefined
    );
  }
  if (type === 'score') {
    const score = answer['score'];
    return (
      typeof score === 'number' &&
      Number.isFinite(score) &&
      score >= 0 &&
      score <= Object.keys(probabilities).length - 1
    );
  }
  return type === 'choice' && answer['score'] === undefined;
}

function validAnswer(value: unknown): boolean {
  const answer = asRecord(value);
  const probabilities = asRecord(answer?.['probabilities']);
  if (answer === undefined || probabilities === undefined) return false;
  return (
    (answer['type'] === 'noul' || answer['type'] === 'choice' || answer['type'] === 'score') &&
    unitNumber(answer['confidence']) &&
    validAnswerProbabilities(probabilities) &&
    validAnswerSemantics(answer, probabilities) &&
    (answer['engineConfidence'] === undefined || unitNumber(answer['engineConfidence']))
  );
}

function validRoute(value: unknown, action: unknown): boolean {
  if (value === undefined) return true;
  const route = asRecord(value);
  if (route === undefined) return false;
  return (
    typeof route['preset'] === 'string' &&
    route['preset'] !== '' &&
    action === `route:${route['preset']}` &&
    optionalString(route['model']) &&
    optionalString(route['mode']) &&
    optionalString(route['thinking']) &&
    optionalString(route['profile'])
  );
}

function validPrecedent(value: unknown): boolean {
  if (value === undefined) return true;
  const tally = asRecord(value);
  if (tally === undefined) return false;
  return (
    Number.isSafeInteger(tally['allows']) &&
    Number.isSafeInteger(tally['denies']) &&
    (tally['allows'] as number) >= 0 &&
    (tally['denies'] as number) >= 0
  );
}

function validDecisionCore(value: Record<string, unknown>): boolean {
  const enforced: unknown = value['enforced'];
  return (
    typeof value['decisionId'] === 'string' &&
    DECISION_ID.test(value['decisionId']) &&
    typeof value['policy'] === 'string' &&
    typeof value['action'] === 'string' &&
    ACTION.test(value['action']) &&
    typeof enforced === 'boolean' &&
    (value['mode'] === 'off' || value['mode'] === 'shadow' || value['mode'] === 'act') &&
    (!enforced || (value['mode'] === 'act' && value['error'] === undefined))
  );
}

function validDecisionDetails(value: Record<string, unknown>): boolean {
  const answers = asRecord(value['answers']);
  const enforced: unknown = value['enforced'];
  return (
    answers !== undefined &&
    (enforced !== true || Object.keys(answers).length > 0) &&
    Object.values(answers).every(validAnswer) &&
    Number.isSafeInteger(value['rule']) &&
    (value['rule'] as number) >= -1 &&
    typeof value['engine'] === 'string' &&
    typeof value['model'] === 'string' &&
    typeof value['latencyMs'] === 'number' &&
    Number.isFinite(value['latencyMs']) &&
    value['latencyMs'] >= 0 &&
    typeof value['cached'] === 'boolean'
  );
}

/** The shape of a gateway decision, whichever policy and scope answered. */
function isDecideShape(value: unknown): value is DecideResponse {
  const response = asRecord(value);
  if (response === undefined || !validDecisionCore(response) || !validDecisionDetails(response)) {
    return false;
  }
  return (
    optionalString(response['variant']) &&
    validRoute(response['route'], response['action']) &&
    validPrecedent(response['precedent']) &&
    optionalString(response['precedentKey']) &&
    optionalString(response['error'])
  );
}

/** Reject malformed or inconsistent gateway decisions before an adapter can enforce them. */
export function isDecideResponse(
  value: unknown,
  policy: string,
  scope: DecideRequest['scope'],
): value is DecideResponse {
  return isDecideShape(value) && value.policy === policy && value.scope === scope;
}

/**
 * The one check behind every auto-allow, shared by the hook runner and the Claude Code mod: a
 * validated decision that was enforced (mode `act`), whose action is `allow`, with no error.
 * Anything else, including a malformed reply, is not an allow.
 */
export function isEnforcedAllow(reply: unknown): reply is DecideResponse {
  return (
    isDecideShape(reply) &&
    reply.enforced &&
    reply.mode === 'act' &&
    reply.action === 'allow' &&
    reply.error === undefined
  );
}

/** True when a URL's host is this machine. */
export function loopbackUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return LOOPBACK.has(hostname) || LOOPBACK_V4.test(hostname);
  } catch {
    return false;
  }
}

/** True for https URLs and loopback hosts; a bearer token is only sent to those. */
export function tokenAllowed(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:' || loopbackUrl(baseUrl);
  } catch {
    return false;
  }
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #token: string | undefined;
  readonly #controlToken: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #clientId: string | undefined;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_GATEWAY_URL);
    this.#timeoutMs = options.timeoutMs ?? 2000;
    // Never send the token in clear text to another machine: https, or loopback only.
    this.#token = tokenAllowed(this.#baseUrl) ? options.token : undefined;
    this.#controlToken =
      loopbackUrl(this.#baseUrl) && options.controlToken !== '' ? options.controlToken : undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clientId = options.clientId;
  }

  /** Run a policy. `null` when the gateway is unreachable, slow, or answers with an error. */
  async decide(policy: string, request: DecideRequest): Promise<DecideResponse | null> {
    const response: unknown = await this.#request<unknown>(
      'POST',
      `/v1/decide/${encodeURIComponent(policy)}`,
      request,
    );
    return isDecideResponse(response, policy, request.scope) ? response : null;
  }

  async reportOutcome(decisionId: string, outcome: string, source = 'user'): Promise<boolean> {
    const res = await this.#request('POST', '/v1/outcomes', { decisionId, outcome, source });
    return res !== null;
  }

  async health(): Promise<GatewayHealth | null> {
    return this.#request<GatewayHealth>('GET', '/health');
  }

  /** List engines and models; null when the gateway is unreachable or returns an error. */
  async engines(): Promise<unknown> {
    return this.#request<unknown>('GET', '/v1/engines');
  }

  /** Select a model and retain its HTTP status and body for CLI error reporting. */
  async selectEngine(selection: EngineSelectionRequest): Promise<GatewayRequestResult | null> {
    return this.#requestWithStatus('POST', '/v1/engine', selection);
  }

  /** Give one policy its own model; the HTTP status and body are kept for CLI error reporting. */
  async setPolicySelection(
    policy: string,
    selection: PolicySelectionRequest,
  ): Promise<GatewayRequestResult | null> {
    return this.#requestWithStatus(
      'POST',
      `/v1/policies/${encodeURIComponent(policy)}/selection`,
      selection,
    );
  }

  /** Put one policy back on the default model. */
  async clearPolicySelection(policy: string): Promise<GatewayRequestResult | null> {
    return this.#requestWithStatus('POST', `/v1/policies/${encodeURIComponent(policy)}/selection`, {
      clear: true,
    });
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const result = await this.#requestWithStatus(method, path, body);
    return result !== null && result.status >= 200 && result.status < 300
      ? (result.body as T)
      : null;
  }

  async #requestWithStatus(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GatewayRequestResult | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#clientId !== undefined) headers[CLIENT_HEADER] = this.#clientId;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.#token !== undefined && this.#token !== '') {
      headers['authorization'] = `Bearer ${this.#token}`;
    }
    if (this.#controlToken !== undefined) {
      headers[CONTROL_HEADER] = this.#controlToken;
    }
    try {
      const res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  }
}
