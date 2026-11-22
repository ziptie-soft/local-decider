/**
 * `agent.create.before` → `routing`. A waiting hook: a throw or a slow answer would fail agent
 * creation, so the whole hook has a ~2 s budget and returns `undefined` (no change) on any failure,
 * when not enforced, or when the chosen preset is not mapped.
 *
 * Two rules keep a route from overriding the creator. An agent created by another agent's
 * `create_agent` call keeps the model its creator chose (`delegation.ts`; the hook has no labels
 * or parent, so it is found by correlation, and any doubt skips the route). And a preset or
 * profile mode is applied only when it is no more permissive than the agent's own (`mode-tiers.ts`).
 * The plugin's own policy-writer agent is never routed. Paseo excludes `internal` agents from
 * every plugin hook (daemon 0.16.2), so no internal check is needed here.
 */
import type { AgentSessionConfig } from '@getpaseo/protocol/agent-types';
import { resolve as resolvePath } from 'node:path';

import { POLICY_WRITER_TITLE } from '../shared/constants.ts';
import type { DecideRequest, DecideResponse, DecisionModels } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import {
  applyPreset,
  presetTarget,
  routeTarget,
  type PresetTarget,
  type ProfileLike,
} from '../shared/presets.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { creatorOf, type Creator, type DelegationPaseo } from './delegation.ts';
import { configDir, errorText, type HookDeps } from './deps.ts';
import { buildRoutingInput } from './history.ts';
import { guardMode } from './mode-tiers.ts';
import { pluginEnforces } from './turn.ts';
import type { UsageLinks } from './usage.ts';

const ROUTING_POLICY = 'routing';
const ROUTING_BUDGET_MS = 2000;
/** Below this much budget left, the gateway call is skipped; it would get at least 500 ms. */
const MIN_ROUTE_DECIDE_MS = 1000;
const SHADOW_TIMEOUT_MS = 30_000;

/** Where Paseo agent profiles come from: the hook context's `paseo.config`. */
export interface ProfileSource {
  readonly config: {
    get(): Promise<{ config: { agentProfiles?: readonly ProfileLike[] | undefined } }>;
  };
}

/** What routing reads from the hook context's `paseo`: profiles, and agents to find a parent. */
export type RoutingPaseo = ProfileSource & DelegationPaseo;

/** Paseo's agent profiles; none when unavailable (an older Paseo, or the call failed). */
async function loadProfiles(paseo: ProfileSource | undefined): Promise<readonly ProfileLike[]> {
  try {
    return (await paseo?.config.get())?.config.agentProfiles ?? [];
  } catch {
    return [];
  }
}

export interface CreateRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
}

interface RoutePlan {
  readonly mode: DeciderSettings['modes'][typeof ROUTING_POLICY];
  readonly settings: DeciderSettings;
  readonly gateway: Gateway;
  readonly body: DecideRequest;
  readonly profiles: readonly ProfileLike[];
}

/** What is left of one `agent.create.before` call: `signal` aborts at the deadline. */
interface Budget {
  readonly signal: AbortSignal;
  readonly caller: AbortSignal;
  remaining(): number;
}

export function createRoutingHandler(
  deps: HookDeps,
  budgetMs = ROUTING_BUDGET_MS,
  usage?: UsageLinks,
  now: () => number = Date.now,
): (
  payload: { request: CreateRequest },
  ctx: { signal: AbortSignal; paseo?: RoutingPaseo },
) => Promise<CreateRequest | undefined> {
  return async ({ request }, ctx) => {
    const deadline = now() + budgetMs;
    const budget: Budget = {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]),
      caller: ctx.signal,
      remaining: () => Math.max(0, deadline - now()),
    };
    try {
      return await withBudget(route(deps, request, budget, usage, ctx.paseo), budget.signal);
    } catch (error) {
      deps.log(`routing skipped: ${errorText(error)}`);
      return undefined;
    }
  };
}

/** Settle like `work`, or with `undefined` as soon as `signal` aborts, whatever `work` is still doing. */
function withBudget<T>(work: Promise<T | undefined>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** What the agent runs on unchanged, and what each preset would switch it to, for savings stats. */
export function routingModels(
  config: { provider: string; model?: string | undefined },
  presets: Parameters<typeof presetTarget>[0],
  profiles: readonly ProfileLike[] = [],
): DecisionModels {
  const routes: Record<string, string> = {};
  for (const preset of Object.keys(presets)) {
    const target = presetTarget(presets, `route:${preset}`);
    if (target !== null) {
      routes[`route:${preset}`] = `${target.provider}/${target.model}`;
    }
  }
  const model = config.model?.trim() ?? '';
  return {
    ...(model === '' ? {} : { requested: `${config.provider}/${model}` }),
    routes,
    ...profileModels(profiles),
  };
}

/** Profile id → `provider/model`, so the gateway can resolve config.yaml profile presets. */
function profileModels(profiles: readonly ProfileLike[]): { profiles?: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const p of profiles) {
    const model = p.model?.trim() ?? '';
    if (model !== '') {
      out[p.id] = `${p.provider}/${model}`;
    }
  }
  return Object.keys(out).length > 0 ? { profiles: out } : {};
}

/** The gateway resolves presets from config.yaml; settings.presets is the pre-config.yaml map. */
function targetOf(res: DecideResponse, plan: RoutePlan): PresetTarget | null {
  return res.route === undefined
    ? presetTarget(plan.settings.presets, res.action)
    : routeTarget(res.route, plan.profiles);
}

async function route(
  deps: HookDeps,
  request: CreateRequest,
  budget: Budget,
  usage: UsageLinks | undefined,
  paseo: RoutingPaseo | undefined,
): Promise<CreateRequest | undefined> {
  const plan = await routePlan(deps, request, paseo);
  if (plan === undefined) {
    return undefined;
  }
  return plan.mode === 'act'
    ? routeAct(plan, deps, request, { budget, usage, paseo })
    : routeShadow(plan, request, usage);
}

async function routePlan(
  deps: HookDeps,
  request: CreateRequest,
  paseo: ProfileSource | undefined,
): Promise<RoutePlan | undefined> {
  if (isPolicyWriter(request.config) || deps.gatewayKnownDown?.() === true) {
    return undefined;
  }
  const settings = await deps.settings();
  const mode = settings.modes[ROUTING_POLICY];
  const input = buildRoutingInput(request.config.cwd, request.config.title);
  if (mode === 'off' || input === null) {
    return undefined;
  }
  const gateway = await deps.gateway();
  if (gateway === null) {
    return undefined;
  }
  const profiles = await loadProfiles(paseo);
  return {
    mode,
    settings,
    gateway,
    profiles,
    body: {
      harness: 'paseo',
      input: { ...input },
      models: routingModels(request.config, settings.presets, profiles),
    },
  };
}

/** The plugin's "Write with an agent" agent: the user picked its model, and it edits the policy. */
function isPolicyWriter(config: { title?: string | null | undefined; cwd: string }): boolean {
  return (
    config.title === POLICY_WRITER_TITLE &&
    resolvePath(config.cwd) === resolvePath(configDir(process.env))
  );
}

function routeShadow(
  plan: RoutePlan,
  request: CreateRequest,
  usage: UsageLinks | undefined,
): undefined {
  // Shadow: nothing will be applied, so never make agent creation wait. The gateway logs it.
  const pending = plan.gateway
    .decide(ROUTING_POLICY, plan.body, { timeoutMs: SHADOW_TIMEOUT_MS })
    .catch(() => null);
  usage?.creating(
    request.config.cwd,
    request.config.title,
    pending.then((r) => r?.decisionId ?? null),
  );
  return undefined;
}

/** What `routeAct` needs beyond the plan: the deadline, usage links and the daemon API. */
interface ActContext {
  readonly budget: Budget;
  readonly usage: UsageLinks | undefined;
  readonly paseo: RoutingPaseo | undefined;
}

async function routeAct(
  plan: RoutePlan,
  deps: HookDeps,
  request: CreateRequest,
  act: ActContext,
): Promise<CreateRequest | undefined> {
  const { budget, usage } = act;
  const remaining = budget.remaining();
  if (remaining < MIN_ROUTE_DECIDE_MS) {
    deps.log('routing skipped: budget spent before decide');
    return undefined;
  }
  // Concurrent with the decision, so finding the creator adds no latency.
  const creator = creatorOf(act.paseo, request.config.title, budget.signal);
  const pending = plan.gateway.decide(ROUTING_POLICY, plan.body, {
    timeoutMs: remaining,
    signal: budget.signal,
  });
  usage?.creating(
    request.config.cwd,
    request.config.title,
    pending.then(
      (r) => r?.decisionId ?? null,
      () => null,
    ),
  );
  const res = await pending;
  if (res === null) {
    markDownOnTimeout(deps, budget);
    return undefined;
  }
  if (!pluginEnforces(res, plan.mode)) {
    return undefined;
  }
  const target = targetOf(res, plan);
  if (target === null) {
    return undefined;
  }
  return applyIfUser(deps, request, { res, target, creator: await creator }, usage);
}

/** Apply the route unless the creator is (or may be) another agent. */
function applyIfUser(
  deps: HookDeps,
  request: CreateRequest,
  chosen: { res: DecideResponse; target: PresetTarget; creator: Creator },
  usage: UsageLinks | undefined,
): CreateRequest | undefined {
  if (chosen.creator !== 'user') {
    deps.log(`routing kept the creator's model (${chosen.creator})`);
    return undefined;
  }
  const out = applyRouteTarget(deps, request, chosen.res, chosen.target);
  if (out !== undefined) {
    usage?.applied(request.config.cwd, request.config.title);
  }
  return out;
}

/**
 * The gateway took the whole budget: mark it down so later creations skip it. A caller abort or a
 * fast failure says nothing about the gateway.
 */
function markDownOnTimeout(deps: HookDeps, budget: Budget): void {
  const reason = budget.signal.reason as { name?: unknown } | undefined;
  if (budget.signal.aborted && reason?.name === 'TimeoutError' && !budget.caller.aborted) {
    deps.markGatewayDown?.();
  }
}

function applyRouteTarget(
  deps: HookDeps,
  request: CreateRequest,
  res: DecideResponse,
  target: PresetTarget,
): CreateRequest | undefined {
  // A preset's or profile's mode applies only when the creator left modeId unset.
  const pinned = (request.config.modeId ?? '').trim() !== '';
  if (pinned && target.provider !== request.config.provider) {
    deps.log('routing skipped: caller pinned mode on another provider');
    return undefined;
  }
  const guard = guardMode(request.config, pinned ? { ...target, modeId: '' } : target);
  if (guard.kind === 'skip') {
    deps.log(`routing skipped: ${target.provider} mode would raise permissions`);
    return undefined;
  }
  if (guard.kind === 'dropped') {
    deps.log(`routing dropped preset mode ${guard.modeId}: more permissive`);
  }
  deps.log(`routing ${res.action} → ${target.provider}/${target.model} (${res.decisionId})`);
  return { ...request, config: applyPreset(request.config, guard.target) };
}
