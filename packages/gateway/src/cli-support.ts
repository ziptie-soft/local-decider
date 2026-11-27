import type { Action } from '@ziptie-soft/local-decider-core';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import type { AgentView } from './explain.ts';

/** A bad command line; the CLI prints it (or the usage text when empty) and exits 2. */
export class UsageError extends Error {}

/** A JSON object from a gateway body, or undefined for anything else. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string from a gateway body, or `fallback`. */
export function displayText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** Parse `--input`: invalid JSON, or JSON that is not an object, is a usage error. */
export function parseInputJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('--input must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The GET shape the policy fetch needs; satisfied by the CLI's authenticated gateway fetch. */
export type PolicyRequest = (
  path: string,
  init: { timeoutMs: number },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

type GatewayResponse = Awaited<ReturnType<PolicyRequest>>;

/**
 * Send one gateway request and return the 2xx response. A thrown request, a 401 (the token is
 * refused) or any other non-2xx answer throws a named error instead of parsing an error body;
 * `onStatus` may name a specific status first.
 */
async function successful(
  send: () => Promise<GatewayResponse>,
  label: string,
  refused: string,
  onStatus: (status: number) => string | undefined = () => undefined,
): Promise<GatewayResponse> {
  let response: GatewayResponse;
  try {
    response = await send();
  } catch (error) {
    throw new Error(
      `gateway unreachable fetching ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.status === 401) {
    throw new Error(refused);
  }
  const named = onStatus(response.status);
  if (named !== undefined) {
    throw new Error(named);
  }
  if (!response.ok) {
    throw new Error(`gateway answered ${String(response.status)} for ${label}`);
  }
  return response;
}

/**
 * `GET /v1/policies` for `policies` and the MCP backend. The request carries the control token
 * when one is configured; a non-2xx answer throws a named error instead of parsing an error body.
 */
export async function fetchPolicyList(request: PolicyRequest, refused: string): Promise<unknown> {
  const label = '/v1/policies';
  const response = await successful(() => request(label, { timeoutMs: 3000 }), label, refused);
  return response.json();
}

/** The POST shape the agent decide needs; satisfied by the CLI's authenticated gateway fetch. */
export type DecideRequestFn = (
  path: string,
  init: { method: 'POST'; body: string; timeoutMs: number },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const agentViewSchema = z.object({
  decisionId: z.string(),
  policy: z.string(),
  action: z.string(),
  enforced: z.boolean(),
  primary: z
    .object({ question: z.string(), answer: z.string(), confidence: z.number() })
    .optional(),
  failedOpen: z.boolean(),
  truncated: z.boolean(),
});

/**
 * A `?view=agent` decide body, rebuilt field by field (zod drops every other key). A gateway that
 * predates the view ignores the query and sends the full response (probabilities, rule, key):
 * that is refused, never projected here, because the matched rule's question is only known to
 * the gateway.
 */
export function parseAgentDecision(body: unknown): AgentView | null {
  const parsed = agentViewSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { primary, action, ...rest } = parsed.data;
  return { ...rest, action: action as Action, ...(primary === undefined ? {} : { primary }) };
}

/**
 * `POST /v1/decide/:policy?view=agent` for the stdio MCP backend: the gateway projects the answer
 * with the matched rule's question, so the primary answer is the one that decided. A non-2xx
 * answer throws a named error.
 */
export async function fetchAgentDecision(
  request: DecideRequestFn,
  policy: string,
  body: unknown,
  timeoutMs: number,
  refused: string,
): Promise<AgentView> {
  const path = `/v1/decide/${encodeURIComponent(policy)}?view=agent`;
  const response = await successful(
    () => request(path, { method: 'POST', body: JSON.stringify(body), timeoutMs }),
    `/v1/decide/${policy}`,
    refused,
    (status) => (status === 403 ? `policy "${policy}" is not available to agents` : undefined),
  );
  const view = parseAgentDecision(await response.json().catch(() => null));
  if (view === null) {
    throw new Error('gateway did not answer with the agent view; update the gateway');
  }
  return view;
}

/** Run one `flm` step; a failure names the step and the exit status instead of a raw stack. */
export function runFlmStep(
  flm: string,
  args: readonly string[],
  exec: typeof execFileSync = execFileSync,
): void {
  try {
    exec(flm, [...args], { stdio: 'inherit' });
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    const how =
      typeof status === 'number'
        ? `exited with status ${String(status)}`
        : `failed to run: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(`flm ${args[0] ?? ''} ${how} (${flm})`, { cause: error });
  }
}
