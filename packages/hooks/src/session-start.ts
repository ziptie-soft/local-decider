/**
 * Claude Code `SessionStart`: one gateway health check, so a session that starts without the
 * gateway says so once. Healthy → no output. Never prints the URL's userinfo, path or the token.
 */
import { str, type GatewayHealth } from '@ziptie-soft/local-decider-core';
import { isLoopbackUrl } from '@ziptie-soft/local-decider-launcher';

import { gatewayClient, gatewayConfig, type Env } from './gateway-config.ts';
import type { HookHarness } from './mapping.ts';

/** Gateway health; `null` when unreachable, slow or erroring. */
export type Health = () => Promise<GatewayHealth | null>;

/** SessionStart has a short hook timeout: never spend more than this on the check. */
const HEALTH_TIMEOUT_MS = 1000;
const MAX_DETAIL = 120;
const MAX_STATUS = 20;

export function healthFromEnv(env: Env, timeoutMs: number): Health {
  const client = gatewayClient(env, Math.min(timeoutMs, HEALTH_TIMEOUT_MS));
  return async () => client.health();
}

/** Gateway text, reduced to printable ASCII on one line and at most `max` characters. */
export function printable(text: string, max: number): string {
  return text
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function originOf(url: string): string {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? 'an invalid URL' : origin;
  } catch {
    return 'an invalid URL';
  }
}

function message(text: string): string {
  return `${JSON.stringify({ systemMessage: `local-decider: ${text}` })}\n`;
}

/** What to tell the user about `health` at `at`; `null` when the gateway is healthy. */
function problem(health: GatewayHealth | null, at: string): string | null {
  if (typeof health !== 'object' || health === null) {
    return `${at} is not reachable; only the built-in command guard is active`;
  }
  if (health.status === 'ok') {
    return null;
  }
  const status = printable(str(health.status) ?? '', MAX_STATUS) || 'unhealthy';
  const raw = typeof health.detail === 'string' ? health.detail : health.engineState;
  const detail = typeof raw === 'string' ? printable(raw, MAX_DETAIL) : '';
  return detail === '' ? `${at} is ${status}` : `${at} is ${status}: ${detail}`;
}

/** The hook's stdout: a `systemMessage` when the gateway is unreachable or not ok, else empty. */
export async function sessionStart(
  harness: HookHarness,
  env: Env,
  health: Health,
  startGateway?: () => void,
): Promise<string> {
  const url = gatewayConfig(env).url;
  const found = problem(await health(), `gateway at ${originOf(url)}`);
  if (found === null) return '';
  const autostart = env['LOCAL_DECIDER_AUTOSTART']?.toLowerCase();
  const shouldStart =
    startGateway !== undefined &&
    isLoopbackUrl(url) &&
    autostart !== '0' &&
    autostart !== 'off' &&
    autostart !== 'false';
  if (shouldStart) startGateway();
  return harness === 'claude'
    ? message(shouldStart ? `${found}; the gateway is starting in the background` : found)
    : '';
}
