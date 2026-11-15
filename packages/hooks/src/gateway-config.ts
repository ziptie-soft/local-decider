/**
 * Where the gateway is and how to authenticate. The environment wins; the plugin's `userConfig`
 * options (`CLAUDE_PLUGIN_OPTION_*`, set by Claude Code even for GUI launches that have no shell
 * environment) come next, then the default. Empty strings count as unset.
 *
 * The token always comes from the same source as the URL, so a token meant for one gateway is
 * never sent to another: `LOCAL_DECIDER_URL` pairs with `LOCAL_DECIDER_TOKEN` only, the option URL
 * with the option token only. With the default URL either token is accepted, env first.
 */
import { DEFAULT_GATEWAY_URL, GatewayClient, str } from '@ziptie-soft/local-decider-core';

export type Env = Readonly<Record<string, string | undefined>>;

export interface GatewayConfig {
  readonly url: string;
  /** Never logged; `GatewayClient` sends it only over https or to loopback. */
  readonly token: string | undefined;
}

export function gatewayConfig(env: Env): GatewayConfig {
  const envToken = str(env['LOCAL_DECIDER_TOKEN']);
  const optionToken = str(env['CLAUDE_PLUGIN_OPTION_GATEWAY_TOKEN']);
  const envUrl = str(env['LOCAL_DECIDER_URL']);
  if (envUrl !== undefined) {
    return { url: envUrl, token: envToken };
  }
  const optionUrl = str(env['CLAUDE_PLUGIN_OPTION_GATEWAY_URL']);
  if (optionUrl !== undefined) {
    return { url: optionUrl, token: optionToken };
  }
  return { url: DEFAULT_GATEWAY_URL, token: envToken ?? optionToken };
}

/** A `GatewayClient` for the gateway `env` points at. */
export function gatewayClient(env: Env, timeoutMs: number): GatewayClient {
  const { url, token } = gatewayConfig(env);
  return new GatewayClient({
    baseUrl: url,
    timeoutMs,
    ...(token === undefined ? {} : { token }),
  });
}
