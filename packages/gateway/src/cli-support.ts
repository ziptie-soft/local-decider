import { execFileSync } from 'node:child_process';

/** A bad command line; the CLI prints it (or the usage text when empty) and exits 2. */
export class UsageError extends Error {}

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

/**
 * `GET /v1/policies` for `policies` and the MCP backend. The request carries the control token
 * when one is configured; a non-2xx answer throws a named error instead of parsing an error body.
 */
export async function fetchPolicyList(request: PolicyRequest, refused: string): Promise<unknown> {
  let response: Awaited<ReturnType<PolicyRequest>>;
  try {
    response = await request('/v1/policies', { timeoutMs: 3000 });
  } catch (error) {
    throw new Error(
      `gateway unreachable fetching /v1/policies: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.status === 401) {
    throw new Error(refused);
  }
  if (!response.ok) {
    throw new Error(`gateway answered ${String(response.status)} for /v1/policies`);
  }
  return response.json();
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
