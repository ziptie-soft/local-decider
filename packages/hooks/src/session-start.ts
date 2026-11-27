/**
 * Claude Code `SessionStart`: one gateway health check, so a session that starts without the
 * gateway says so once. Healthy → no output. Never prints the URL's userinfo, path or the token.
 */
import { str, type GatewayClient, type GatewayHealth } from '@ziptie-soft/local-decider-core';
import { isLoopbackUrl } from '@ziptie-soft/local-decider-launcher';
import { gatewaySocketPathForEnv } from '@ziptie-soft/local-decider-launcher/socket-path';

import { gatewayClient, hooksClientId } from './gateway-client.ts';
import { gatewayConfig, type Env } from './gateway-config.ts';
import type { HookHarness } from './mapping.ts';

/** Gateway health; `null` when unreachable, slow or erroring. */
export type Health = () => Promise<GatewayHealth | null>;

/** SessionStart has a short hook timeout: never spend more than this on the check. */
const HEALTH_TIMEOUT_MS = 1000;
const MAX_DETAIL = 120;
const MAX_STATUS = 20;
const GUIDE_URL_BASE = 'https://github.com/ziptie-soft/local-decider/blob/master/docs/';
export const LEGACY_DETAIL_PREFIX = 'an older gateway runs on';

export function guideUrl(harness: HookHarness): string {
  return `${GUIDE_URL_BASE}install-${harness}.ai.md`;
}

export function healthFromEnv(
  env: Env,
  timeoutMs: number,
  harness: HookHarness = 'claude',
): Health {
  const config = gatewayConfig(env);
  const client = gatewayClient(env, Math.min(timeoutMs, HEALTH_TIMEOUT_MS), harness);
  const socketPath = config.defaultEndpoint ? gatewaySocketPathForEnv(env) : null;
  return () => socketAwareHealth(client, config.url, socketPath, harness);
}

async function socketAwareHealth(
  client: GatewayClient,
  url: string,
  socketPath: string | null,
  harness: HookHarness,
): Promise<GatewayHealth | null> {
  const health = await client.health();
  if (health !== null || socketPath === null) return health;
  return legacyHealth(url, harness);
}

async function legacyHealth(url: string, harness: HookHarness): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(new URL('/health', url), {
      method: 'GET',
      redirect: 'error',
      headers: { 'x-local-decider-client': hooksClientId(harness) },
      signal: AbortSignal.timeout(250),
    });
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>)['status'] !== 'string' ||
      (value as Record<string, unknown>)['instance'] !== undefined
    )
      return null;
    const port = new URL(url).port || '8765';
    return {
      status: 'down',
      detail: `${LEGACY_DETAIL_PREFIX} :${port} without a socket; run \`local-decider gateway restart\``,
    };
  } catch {
    return null;
  }
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
  const healthResult = await health();
  const found = problem(healthResult, `gateway at ${originOf(url)}`);
  const legacy =
    healthResult?.status === 'down' &&
    typeof healthResult.detail === 'string' &&
    healthResult.detail.startsWith(LEGACY_DETAIL_PREFIX);
  if (found === null) return '';
  const autostart = env['LOCAL_DECIDER_AUTOSTART']?.toLowerCase();
  const shouldStart =
    !legacy &&
    startGateway !== undefined &&
    isLoopbackUrl(url) &&
    autostart !== '0' &&
    autostart !== 'off' &&
    autostart !== 'false';
  if (shouldStart) startGateway();
  if (harness !== 'claude') return '';
  if (shouldStart) return message(`${found}; the gateway is starting in the background`);
  if (legacy) return message(found);
  return message(`${found}. Setup guide: ${guideUrl(harness)}`);
}
