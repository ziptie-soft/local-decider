/**
 * Fail-open client of the local-decider gateway. Every call has a hard timeout and resolves to
 * `null` or `false` on any failure (gateway down, slow, redirected, non-2xx, bad JSON, aborted),
 * so the extension falls back to pi's default behaviour. It never throws and never puts the token
 * in an error or return value. Uses only the global `fetch` and `AbortSignal`.
 */

/** Mirrors `packages/core/src/decision.ts` (`Harness`, `DecideRequest`, `DecideResponse`). */
export interface DecideRequest {
  readonly harness: 'pi';
  readonly sessionId?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly workspace?: { readonly cwd: string };
  readonly call?: { readonly id: string; readonly agent?: boolean };
  readonly budgetMs?: number;
}

export interface DecideReply {
  readonly decisionId: string;
  readonly policy?: string;
  readonly mode: string;
  readonly action: string;
  readonly enforced: boolean;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface GatewayOptions {
  readonly url: string;
  /** Bearer token; sent only over https or to a loopback host, never logged. */
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface CallOptions {
  readonly timeoutMs: number;
  /** Caller's abort signal, e.g. pi's `ctx.signal`; may be absent. */
  readonly signal?: AbortSignal | undefined;
}

export interface Gateway {
  decide(policy: string, request: DecideRequest, options: CallOptions): Promise<DecideReply | null>;
  reportOutcome(
    decisionId: string,
    outcome: 'allow' | 'decline',
    options: CallOptions,
  ): Promise<boolean>;
  health(options: CallOptions): Promise<boolean>;
  systemOne(body: unknown, options: CallOptions): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Left between a decide `budgetMs` and the call's timeout for the round trip. */
const BUDGET_MARGIN_MS = 500;

/** `url` as `scheme://host[:port][/path]` without trailing slashes, or null when unusable. */
function normaliseUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function bearerAllowed(baseUrl: string): boolean {
  const { protocol, hostname } = new URL(baseUrl);
  return (
    protocol === 'https:' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    LOOPBACK_V4.test(hostname)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecideReply(value: unknown): value is DecideReply {
  return (
    isRecord(value) &&
    typeof value['decisionId'] === 'string' &&
    UUID.test(value['decisionId']) &&
    typeof value['action'] === 'string' &&
    typeof value['mode'] === 'string' &&
    typeof value['enforced'] === 'boolean' &&
    isRecord(value['answers']) &&
    (value['error'] === undefined || typeof value['error'] === 'string')
  );
}

/** A validated decision that was enforced (mode `act`), allowed, with no error. */
export function isEnforcedAllow(reply: unknown): reply is DecideReply {
  return (
    isDecideReply(reply) &&
    reply.enforced &&
    reply.mode === 'act' &&
    reply.action === 'allow' &&
    reply.error === undefined
  );
}

function signalFor(options: CallOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
}

function budgetFor(timeoutMs: number): number | undefined {
  const budget = Math.floor(timeoutMs - BUDGET_MARGIN_MS);
  return Number.isFinite(budget) && budget > 0 ? budget : undefined;
}

/** With an unusable URL every call resolves to `null` or `false` without any I/O. */
export function createGateway(options: GatewayOptions): Gateway {
  const baseUrl = normaliseUrl(options.url);
  const doFetch = options.fetch ?? globalThis.fetch;
  const token =
    baseUrl !== null &&
    options.token !== undefined &&
    options.token !== '' &&
    bearerAllowed(baseUrl)
      ? options.token
      : undefined;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions,
  ): Promise<unknown> {
    if (baseUrl === null) return null;
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: signalFor(call),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  return {
    async decide(policy, req, call) {
      const budgetMs = req.budgetMs ?? budgetFor(call.timeoutMs);
      const body = budgetMs === undefined ? req : { ...req, budgetMs };
      const res = await request('POST', `/v1/decide/${encodeURIComponent(policy)}`, body, call);
      return isDecideReply(res) ? res : null;
    },
    async reportOutcome(decisionId, outcome, call) {
      const res = await request(
        'POST',
        '/v1/outcomes',
        { decisionId, outcome, source: 'user' },
        call,
      );
      return res !== null;
    },
    async health(call) {
      const res = await request('GET', '/health', undefined, call);
      return isRecord(res) && typeof res['status'] === 'string';
    },
    systemOne: async (body, call) => request('POST', '/v1/systemone', body, call),
  };
}
