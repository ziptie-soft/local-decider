/**
 * `agent.open.before`: tell the harness hooks inside the agent which policies this plugin runs,
 * and optionally attach the agent tools (`agentTools` setting). Launch-only. Never awaits a write
 * to the agent being opened (that would deadlock).
 */
import type { AgentToolDefinition, PluginSessionOpenRequest } from '@getpaseo/plugin/server';

import { HOOK_POLICIES, HOST_POLICIES_ENV, POLICY_WRITER_LABEL } from '../shared/constants.ts';
import { agentTools } from './agent-tools.ts';
import type { HookDeps } from './deps.ts';

/**
 * `env` with this plugin's policies added to `LOCAL_DECIDER_HOST_POLICIES`. All of them, whatever
 * their mode: Paseo settings govern Paseo agents, so `off` here means off, not "let hooks do it".
 */
export function hostEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const listed = (env[HOST_POLICIES_ENV] ?? '').split(',').map((p) => p.trim());
  const policies = new Set([...listed.filter((p) => p !== ''), ...HOOK_POLICIES]);
  return { ...env, [HOST_POLICIES_ENV]: [...policies].join(',') };
}

/**
 * Attach the agent tools when the setting is on and the agent is interactive. The plugin's own
 * policy-writer agent never gets them, so it cannot decide on its own work. Reads local settings
 * only: opening an agent never waits on the gateway.
 */
async function attachedTools(
  deps: HookDeps,
  request: PluginSessionOpenRequest,
  tools: readonly AgentToolDefinition[],
): Promise<AgentToolDefinition[]> {
  const settings = await deps.settings();
  const writer = request.labels[POLICY_WRITER_LABEL] === 'policy-writer';
  return settings.agentTools && !writer ? [...request.tools, ...tools] : request.tools;
}

export function createOpenHandler(
  deps: HookDeps,
): (payload: {
  request: PluginSessionOpenRequest;
}) => Promise<PluginSessionOpenRequest | undefined> {
  // Built once per plugin start; the limiters inside are keyed by agent id.
  const tools = agentTools(deps);
  return async ({ request }) => {
    if (request.purpose === 'history') {
      return undefined;
    }
    return {
      ...request,
      env: hostEnv(request.env),
      tools: await attachedTools(deps, request, tools),
    };
  };
}
