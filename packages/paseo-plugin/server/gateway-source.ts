import { TOKEN_ENV, TOKEN_ORIGIN_ENV } from '../shared/constants.ts';
import { DEFAULT_GATEWAY_URL } from '../shared/constants.ts';
import { createGateway, type Gateway, type GatewayOptions } from '../shared/gateway.ts';
import { bearerAllowed, loopbackUrl, originOf } from '../shared/url.ts';
import { readLocalToken } from './deps.ts';
import { gatewaySocketPathForEnv } from './launcher/socket-path.ts';
import { socketFetch } from './launcher/transport.ts';

export interface GatewaySourceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  readonly clientId?: string;
  readonly create?: typeof createGateway;
}

/**
 * The Unix socket the plugin talks to the gateway over, or null for TCP: only for the default
 * URL (and no `LOCAL_DECIDER_URL` override), with the socket setting on, on POSIX.
 */
export function localSocketFor(
  url: string,
  useSocket: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const defaultEndpoint =
    url === DEFAULT_GATEWAY_URL && (env['LOCAL_DECIDER_URL']?.trim() ?? '') === '';
  return useSocket && defaultEndpoint ? gatewaySocketPathForEnv(env) : null;
}

/** Builds the Gateway for a URL and transport with scoped credentials, cached per both. */
export function gatewaySource(
  options: GatewaySourceOptions,
): (url: string, useSocket?: boolean) => Gateway | null {
  const env = options.env ?? process.env;
  const create = options.create ?? createGateway;
  let report: string | undefined;
  let control: string | undefined;
  let cached: { key: string; gateway: Gateway | null } | null = null;
  const warned = new Set<string>();

  function refreshTokens(): boolean {
    let changed = false;
    if (report === undefined) {
      const next = readLocalToken('report-token', env);
      changed = changed || next !== report;
      report = next;
    }
    if (control === undefined) {
      const next = readLocalToken('control-token', env);
      changed = changed || next !== control;
      control = next;
    }
    return changed;
  }

  function invalidate(): void {
    report = undefined;
    control = undefined;
    cached = null;
  }

  function warnWithheld(
    url: string,
    token: string | undefined,
    tokenOrigin: string | undefined,
  ): void {
    const origin = originOf(url);
    if (
      token === undefined ||
      loopbackUrl(url) ||
      bearerAllowed(url, tokenOrigin) ||
      origin === null ||
      warned.has(origin)
    )
      return;
    const reason = origin.startsWith('https://')
      ? 'set LOCAL_DECIDER_TOKEN_ORIGIN in the daemon environment to send it'
      : 'a remote gateway must use https';
    options.log(`bearer withheld from ${origin}: ${reason}`);
    warned.add(origin);
  }

  function build(url: string, useSocket: boolean): Gateway | null {
    const token = env[TOKEN_ENV] || undefined;
    const tokenOrigin = env[TOKEN_ORIGIN_ENV] || undefined;
    warnWithheld(url, token, tokenOrigin);
    const socketPath = localSocketFor(url, useSocket, env);
    const gatewayOptions: GatewayOptions = {
      baseUrl: url,
      token,
      clientId: options.clientId ?? 'paseo/0.0.0',
      ...(socketPath === null ? {} : { fetch: socketFetch(socketPath) }),
      tokenOrigin,
      reportToken: report,
      controlToken: control,
      onUnauthorised: invalidate,
    };
    return create(gatewayOptions);
  }

  return (url, useSocket = true) => {
    const changed = refreshTokens();
    const key = `${useSocket ? 'unix' : 'tcp'} ${url}`;
    if (changed || cached?.key !== key) {
      cached = { key, gateway: build(url, useSocket) };
    }
    return cached.gateway;
  };
}
