/**
 * Where the gateway is and how to authenticate. The environment wins; the plugin's `userConfig`
 * options (`CLAUDE_PLUGIN_OPTION_*`, set by Claude Code even for GUI launches that have no shell
 * environment) come next, then the default. Empty strings count as unset.
 */
import { DEFAULT_GATEWAY_URL, str } from '@ziptie-soft/local-decider-core';

export type Env = Readonly<Record<string, string | undefined>>;

export interface GatewayConfig {
  readonly url: string;
  /** Never logged; `GatewayClient` sends it only over https or to loopback. */
  readonly token: string | undefined;
}

export function gatewayConfig(env: Env): GatewayConfig {
  return {
    url:
      str(env['LOCAL_DECIDER_URL']) ??
      str(env['CLAUDE_PLUGIN_OPTION_GATEWAY_URL']) ??
      DEFAULT_GATEWAY_URL,
    token: str(env['LOCAL_DECIDER_TOKEN']) ?? str(env['CLAUDE_PLUGIN_OPTION_GATEWAY_TOKEN']),
  };
}
