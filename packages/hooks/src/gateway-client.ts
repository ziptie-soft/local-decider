import { GatewayClient } from '@ziptie-soft/local-decider-core';
import { gatewaySocketPathForEnv } from '@ziptie-soft/local-decider-launcher/socket-path';
import { socketFetch } from '@ziptie-soft/local-decider-launcher/transport';
import { readFileSync } from 'node:fs';

import { gatewayConfig, type Env } from './gateway-config.ts';

let cachedVersion: string | null = null;

function hooksVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
      const version = (manifest as Record<string, unknown>)['version'];
      if (typeof version === 'string') {
        cachedVersion = version;
        return version;
      }
    }
  } catch {
    // Fall back when the manifest is not available in a host installation.
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

export function hooksClientId(harness: 'claude' | 'codex'): string {
  return `${harness}-hooks/${hooksVersion()}`;
}

/** A `GatewayClient` for the gateway `env` points at. */
export function gatewayClient(
  env: Env,
  timeoutMs: number,
  harness: 'claude' | 'codex' = 'claude',
): GatewayClient {
  const { url, token, defaultEndpoint } = gatewayConfig(env);
  const socketPath = defaultEndpoint ? gatewaySocketPathForEnv(env) : null;
  return new GatewayClient({
    baseUrl: url,
    timeoutMs,
    clientId: hooksClientId(harness),
    ...(socketPath === null ? {} : { fetch: socketFetch(socketPath) }),
    ...(token === undefined ? {} : { token }),
  });
}
