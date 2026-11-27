/**
 * Fail-open client of the local-decider gateway, with the same semantics as core's
 * `GatewayClient`: every call has a hard timeout and resolves to `null` on any failure (gateway
 * down, slow, non-2xx, bad JSON, aborted), so hooks fall back to Paseo's default behaviour.
 * Uses only the global `fetch` and `AbortSignal`, so it has no runtime dependencies.
 */
import { CONTROL_HEADER, REPORT_HEADER } from './constants.ts';
import type {
  AgentDecideRequest,
  AgentPolicy,
  AgentView,
  DecideRequest,
  DecideResponse,
  GatewayHealth,
  OutcomeSource,
  UsageReport,
} from './decision.ts';
import { bearerAllowed, loopbackUrl, normaliseBaseUrl } from './url.ts';

export interface GatewayOptions {
  readonly baseUrl?: string;
  /** Default per-call budget. */
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway; read from the daemon environment, never logged. */
  readonly token?: string | undefined;
  readonly tokenOrigin?: string | undefined;
  /** Server-only token for authenticating outcome reports to a local gateway. */
  readonly reportToken?: string | undefined;
  readonly controlToken?: string | undefined;
  /** Called after any 401; never receives a token. */
  readonly onUnauthorised?: (() => void) | undefined;
  readonly fetch?: typeof fetch;
  /** Informational identity for requests received by the local gateway. */
  readonly clientId?: string;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  /** Caller's abort signal, e.g. a hook's `ctx.signal`. */
  readonly signal?: AbortSignal;
}

export interface Gateway {
  readonly baseUrl: string;
  readonly bearer: boolean;
  decide(
    policy: string,
    request: DecideRequest,
    options?: CallOptions,
  ): Promise<DecideResponse | null>;
  reportOutcome(
    decisionId: string,
    outcome: string,
    source: OutcomeSource,
    options?: CallOptions,
  ): Promise<boolean>;
  /** `POST /v1/usage`: token counts of one agent turn; false when not recorded. */
  reportUsage(usage: UsageReport, options?: CallOptions): Promise<boolean>;
  health(options?: CallOptions): Promise<GatewayHealth | null>;
  /** `GET /v1/engines`: engines, their models, downloads and the active selection. */
  engines(options?: CallOptions): Promise<unknown>;
  stats(options?: CallOptions): Promise<unknown>;
  /**
   * `POST /v1/engine`: switch the served engine and model (the gateway persists it). Device
   * `auto` or absent keeps the gateway's device. Unlike the read calls, reports why it failed.
   */
  selectEngine(selection: EngineSelection, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/mode`: automatic selection on, or manual keeping the running engine. */
  setSelectionMode(
    mode: 'auto' | 'manual',
    family?: string,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `GET /v1/benchmark`: the benchmark job's view; null when the gateway does not answer. */
  benchmark(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/benchmark`: start a job (202 with its view); `client: 'paseo'` is added. */
  benchmarkStart(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/benchmark/cancel`: stop the running job; 409 when none runs. */
  benchmarkCancel(options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/models/download`: start downloading a model; 202 with `{download}`. */
  downloadModel(
    target: { engine: string; model: string },
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/models/remove`: delete a downloaded model's files; 409 while it is in use. */
  removeModel(
    target: { engine: string; model: string },
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/engines/validate`: re-run an engine's self check (FastFlowLM's `flm validate`). */
  validateEngine(engine: string, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/config/engine`: save an OpenAI-like engine's URL, model and token variable name. */
  saveEngineConnection(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/engines/discover`: `{}` lists local servers, `{engine, url}` probes one URL. */
  discoverServers(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/paths`: set a tool path or directory; null returns to automatic discovery. */
  setPath(key: string, value: string | null, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/load` (202) or `/v1/engine/unload`: load the model now, or free it. */
  engineLoad(action: 'load' | 'unload', options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/lifecycle`: lazy (load on demand, unload when idle) or eager; persisted. */
  setLifecycle(lifecycle: Lifecycle, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/policies/:id/mode`: the gateway's run mode for a policy; persisted. */
  setPolicyMode(policy: string, mode: string, options?: CallOptions): Promise<PostResult>;
  /**
   * `POST /v1/policies/:id/selection`: the policy's own model, or `{clear: true}` for the default
   * model; persisted. The gateway answers 409 when the model does not fit.
   */
  setPolicySelection(
    policy: string,
    selection: PolicySelectionBody,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `GET /v1/policies`: every policy with its routes, and for each base policy its variants. */
  policies(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/policies/:id/variant`: which variant answers for a policy; persisted. */
  setPolicyVariant(policy: string, variant: string, options?: CallOptions): Promise<PostResult>;
  /**
   * `POST /v1/policies/:id/thresholds`: override rule thresholds by `<question>.<answer>`, null
   * restores the policy file's value; persisted in config.yaml.
   */
  setPolicyThresholds(
    policy: string,
    thresholds: Readonly<Record<string, number | null>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/policies/reload`: re-read the policy files, e.g. after adding one. */
  reloadPolicies(options?: CallOptions): Promise<PostResult>;
  /** `GET /v1/config`: config.yaml's path, schemas and content as the gateway applies it. */
  config(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/routing/presets`: map a preset for a harness in config.yaml; null model removes. */
  setRoutingPreset(update: PresetUpdate, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/decide/:policy?view=agent`: the agent projection; never throws. */
  decideAgent(
    policy: string,
    request: AgentDecideRequest,
    options?: CallOptions,
  ): Promise<AgentResult<AgentView>>;
  /** `GET /v1/decisions/:id?view=agent` (control token, loopback only); never throws. */
  decision(id: string, options?: CallOptions): Promise<AgentResult<AgentView>>;
  /** `GET /v1/review` (control token, loopback only): the body, or null on any failure. */
  review(days: number, limit: number, options?: CallOptions): Promise<unknown>;
  /** `GET /v1/policies?view=agent`: the policies an agent may call; never throws. */
  agentPolicies(options?: CallOptions): Promise<AgentResult<readonly AgentPolicy[]>>;
  /** `GET /v1/policies/:id/prompt`: the prompt that has an agent write a variant of `id`. */
  policyPrompt(policy: string, options?: CallOptions): Promise<unknown>;
}

/** Without a model and a profile, the mapping is removed. */
export interface PresetUpdate {
  readonly harness: 'paseo';
  readonly preset: string;
  readonly model?: string;
  readonly profile?: string;
  readonly mode?: string;
  readonly thinking?: string;
}

export interface Lifecycle {
  readonly lifecycle: 'lazy' | 'eager';
  readonly idleUnloadMinutes?: number;
}

export interface EngineSelection {
  readonly engine?: string;
  readonly model: string;
  readonly device?: string;
}

/** The body of `POST /v1/policies/:id/selection`. */
export type PolicySelectionBody =
  | { readonly clear: true }
  | {
      readonly engine: string;
      readonly model: string;
      readonly device?: string | undefined;
      readonly fallback?: 'default' | 'open' | undefined;
    };

/** An agent-tool read: the value, or a one-line error that is safe to show to the agent. */
export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A mutating call's outcome: the response body, or the gateway's error message. */
export type PostResult = { ok: true; body: unknown } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 2000;
/** Left between `budgetMs` and the call's timeout for the round trip. */
const BUDGET_MARGIN_MS = 500;

function budgetFor(timeoutMs: number): number | undefined {
  const budget = Math.floor(timeoutMs - BUDGET_MARGIN_MS);
  return Number.isFinite(budget) && budget > 0 ? budget : undefined;
}
const BENCHMARK_READ_MS = 3000;
const BENCHMARK_POST_MS = 10_000;

function credentials(
  baseUrl: string,
  options: GatewayOptions,
): { token?: string; reportToken?: string; controlToken?: string } {
  const local = loopbackUrl(baseUrl);
  return {
    ...(options.token && bearerAllowed(baseUrl, options.tokenOrigin)
      ? { token: options.token }
      : {}),
    ...(local && options.reportToken ? { reportToken: options.reportToken } : {}),
    ...(local && options.controlToken ? { controlToken: options.controlToken } : {}),
  };
}

function isDecideResponse(value: unknown): value is DecideResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['decisionId'] === 'string' &&
    typeof v['action'] === 'string' &&
    typeof v['enforced'] === 'boolean' &&
    typeof v['answers'] === 'object' &&
    v['answers'] !== null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrimary(value: unknown): AgentView['primary'] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value['question'] !== 'string' ||
    typeof value['answer'] !== 'string' ||
    typeof value['confidence'] !== 'number'
  ) {
    return null;
  }
  return { question: value['question'], answer: value['answer'], confidence: value['confidence'] };
}

/**
 * The agent projection, rebuilt field by field so nothing else a gateway sends can reach an agent.
 * A full decision from an older gateway (no `failedOpen`) is rejected.
 */
function parseAgentView(value: unknown): AgentView | null {
  if (!isRecord(value)) return null;
  const primary = parsePrimary(value['primary']);
  if (
    typeof value['decisionId'] !== 'string' ||
    typeof value['policy'] !== 'string' ||
    typeof value['action'] !== 'string' ||
    typeof value['enforced'] !== 'boolean' ||
    typeof value['failedOpen'] !== 'boolean' ||
    typeof value['truncated'] !== 'boolean' ||
    primary === null
  ) {
    return null;
  }
  return {
    decisionId: value['decisionId'],
    policy: value['policy'],
    action: value['action'] as AgentView['action'],
    enforced: value['enforced'],
    ...(primary === undefined ? {} : { primary }),
    failedOpen: value['failedOpen'],
    truncated: value['truncated'],
  };
}

function parseQuestions(value: unknown): AgentPolicy['questions'] | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).map(([id, q]) =>
    isRecord(q) &&
    typeof q['instructions'] === 'string' &&
    Array.isArray(q['options']) &&
    q['options'].every((o) => typeof o === 'string')
      ? ([id, { instructions: q['instructions'], options: q['options'] }] as const)
      : null,
  );
  return entries.includes(null)
    ? null
    : Object.fromEntries(entries as (readonly [string, AgentPolicy['questions'][string]])[]);
}

function parseAgentPolicy(value: unknown): AgentPolicy | null {
  if (!isRecord(value)) return null;
  const questions = parseQuestions(value['questions']);
  const keys = value['inputKeys'];
  if (
    typeof value['id'] !== 'string' ||
    typeof value['description'] !== 'string' ||
    !Array.isArray(keys) ||
    !keys.every((k) => typeof k === 'string') ||
    questions === null
  ) {
    return null;
  }
  return {
    id: value['id'],
    description: value['description'],
    inputKeys: keys,
    questions,
  };
}

function parseAgentPolicies(value: unknown): readonly AgentPolicy[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parseAgentPolicy);
  return parsed.includes(null) ? null : (parsed as AgentPolicy[]);
}

const AGENT_ERROR_CHARS = 160;

/** One line without control characters, capped: gateway and network text shown to an agent. */
export function agentErrorText(text: string): string {
  const clean = text
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return clean.slice(0, AGENT_ERROR_CHARS);
}

async function agentFailure(res: Response, notFound: string | undefined): Promise<string> {
  if (res.status === 404 && notFound !== undefined) return notFound;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const reason = typeof body?.error === 'string' ? agentErrorText(body.error) : '';
  return reason === '' ? `gateway answered HTTP ${String(res.status)}` : reason;
}

function isHealth(value: unknown): value is GatewayHealth {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unreachable';
}

async function failure(res: Response): Promise<PostResult> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const reason = typeof body?.error === 'string' ? body.error.slice(0, 300) : '';
  return { ok: false, error: reason === '' ? `HTTP ${String(res.status)}` : reason };
}

/** Device `auto` (or none) is left out so the gateway keeps its own. */
function selectionBody(selection: EngineSelection): Record<string, string> {
  const body: Record<string, string> = { model: selection.model };
  if (selection.engine !== undefined && selection.engine !== '') {
    body['engine'] = selection.engine;
  }
  if (selection.device !== undefined && selection.device !== 'auto') {
    body['device'] = selection.device;
  }
  return body;
}

function signalFor(defaultMs: number, options: CallOptions | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? defaultMs);
  return options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
}

function notifyUnauthorised(res: Response, callback: (() => void) | undefined): void {
  if (res.status === 401) callback?.();
}

export function createGateway(options: GatewayOptions = {}): Gateway | null {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  if (baseUrl === null) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const { token, reportToken, controlToken } = credentials(baseUrl, options);

  function headersFor(body: unknown, path: string): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.clientId !== undefined) headers['x-local-decider-client'] = options.clientId;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token !== undefined && token !== '') {
      headers['authorization'] = `Bearer ${token}`;
    }
    if (
      (path === '/v1/outcomes' || path === '/v1/usage') &&
      reportToken !== undefined &&
      reportToken !== ''
    ) {
      headers[REPORT_HEADER] = reportToken;
    }
    if (controlToken !== undefined && controlToken !== '') {
      headers[CONTROL_HEADER] = controlToken;
    }
    return headers;
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<Response> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headersFor(body, path),
      redirect: 'error',
      signal: signalFor(timeoutMs, call),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    notifyUnauthorised(res, options.onUnauthorised);
    return res;
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<unknown> {
    try {
      const res = await send(method, path, body, call);
      if (!res.ok) {
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
  }

  async function post(
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<PostResult> {
    try {
      const res = await send('POST', path, body, call);
      if (!res.ok) {
        return await failure(res);
      }
      return { ok: true, body: await res.json().catch(() => null) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async function agentRead<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
    parse: (value: unknown) => T | null,
    notFound?: string,
  ): Promise<AgentResult<T>> {
    try {
      const res = await send(method, path, body, call);
      if (!res.ok) {
        return { ok: false, error: await agentFailure(res, notFound) };
      }
      const value = parse(await res.json().catch(() => null));
      return value === null
        ? { ok: false, error: 'unexpected gateway response' }
        : { ok: true, value };
    } catch (error) {
      return { ok: false, error: agentErrorText(errorMessage(error)) || 'gateway unreachable' };
    }
  }

  const explainBlocker = (): string | null => {
    if (!loopbackUrl(baseUrl)) return 'explain needs a loopback gateway';
    return controlToken === undefined || controlToken === ''
      ? 'explain needs the gateway control token'
      : null;
  };

  return {
    baseUrl,
    bearer: token !== undefined,
    async decide(policy, req, call) {
      // The caller's wait, so a busy gateway can answer at once instead of timing out.
      const budgetMs = req.budgetMs ?? budgetFor(call?.timeoutMs ?? timeoutMs);
      const body = budgetMs === undefined ? req : { ...req, budgetMs };
      const res = await request('POST', `/v1/decide/${encodeURIComponent(policy)}`, body, call);
      return isDecideResponse(res) ? res : null;
    },
    async decideAgent(policy, req, call) {
      const budgetMs = req.budgetMs ?? budgetFor(call?.timeoutMs ?? timeoutMs);
      const body = budgetMs === undefined ? req : { ...req, budgetMs };
      return agentRead(
        'POST',
        `/v1/decide/${encodeURIComponent(policy)}?view=agent`,
        body,
        call,
        parseAgentView,
      );
    },
    async decision(id, call) {
      const blocker = explainBlocker();
      if (blocker !== null) return { ok: false, error: blocker };
      return agentRead(
        'GET',
        `/v1/decisions/${encodeURIComponent(id)}?view=agent`,
        undefined,
        call,
        parseAgentView,
        'unknown decision',
      );
    },
    review: async (days, limit, call) =>
      request(
        'GET',
        `/v1/review?days=${String(Math.trunc(days))}&limit=${String(Math.trunc(limit))}`,
        undefined,
        call,
      ),
    agentPolicies: async (call) =>
      agentRead('GET', '/v1/policies?view=agent', undefined, call, parseAgentPolicies),
    async reportOutcome(decisionId, outcome, source, call) {
      const res = await request('POST', '/v1/outcomes', { decisionId, outcome, source }, call);
      return res !== null;
    },
    async reportUsage(usage, call) {
      return (await request('POST', '/v1/usage', usage, call)) !== null;
    },
    async health(call) {
      const res = await request('GET', '/health', undefined, call);
      return isHealth(res) ? res : null;
    },
    engines: async (call) => request('GET', '/v1/engines', undefined, call),
    stats: async (call) => request('GET', '/v1/stats', undefined, call),
    selectEngine: async (selection, call) => post('/v1/engine', selectionBody(selection), call),
    setSelectionMode: async (mode, family, call) =>
      post('/v1/engine/mode', family === undefined ? { mode } : { mode, family }, call),
    benchmark: async (call) =>
      request('GET', '/v1/benchmark', undefined, { timeoutMs: BENCHMARK_READ_MS, ...call }),
    benchmarkStart: async (body, call) =>
      post(
        '/v1/benchmark',
        { ...body, client: 'paseo' },
        { timeoutMs: BENCHMARK_POST_MS, ...call },
      ),
    benchmarkCancel: async (call) =>
      post('/v1/benchmark/cancel', {}, { timeoutMs: BENCHMARK_POST_MS, ...call }),
    downloadModel: async (target, call) => post('/v1/models/download', { ...target }, call),
    removeModel: async (target, call) => post('/v1/models/remove', { ...target }, call),
    validateEngine: async (engine, call) => post('/v1/engines/validate', { engine }, call),
    saveEngineConnection: async (body, call) => post('/v1/config/engine', { ...body }, call),
    discoverServers: async (body, call) => post('/v1/engines/discover', { ...body }, call),
    setPath: async (key, value, call) => post('/v1/paths', { key, value }, call),
    engineLoad: async (action, call) => post(`/v1/engine/${action}`, {}, call),
    setLifecycle: async (lifecycle, call) => post('/v1/engine/lifecycle', { ...lifecycle }, call),
    setPolicyMode: async (policy, mode, call) =>
      post(`/v1/policies/${encodeURIComponent(policy)}/mode`, { mode }, call),
    setPolicySelection: async (policy, selection, call) =>
      post(`/v1/policies/${encodeURIComponent(policy)}/selection`, { ...selection }, call),
    policies: async (call) => request('GET', '/v1/policies', undefined, call),
    setPolicyVariant: async (policy, variant, call) =>
      post(`/v1/policies/${encodeURIComponent(policy)}/variant`, { variant }, call),
    setPolicyThresholds: async (policy, thresholds, call) =>
      post(
        `/v1/policies/${encodeURIComponent(policy)}/thresholds`,
        { thresholds: { ...thresholds } },
        call,
      ),
    reloadPolicies: async (call) => post('/v1/policies/reload', {}, call),
    config: async (call) => request('GET', '/v1/config', undefined, call),
    setRoutingPreset: async (update, call) => post('/v1/routing/presets', { ...update }, call),
    policyPrompt: async (policy, call) =>
      request('GET', `/v1/policies/${encodeURIComponent(policy)}/prompt`, undefined, call),
  };
}
