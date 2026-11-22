/**
 * The plugin's agent tools (`local_decider_decide`, `_explain`, `_policies`), attached in
 * `agent.open.before` and served by Paseo's agent-scoped `paseo` MCP server. They run in the
 * plugin process, so the gateway URL and its tokens never reach agent config. Every failure is a
 * one-line tool error the agent can ignore; nothing here throws past the SDK.
 */
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from '@getpaseo/plugin/server';
import { z } from 'zod';

import { AGENT_TOOL_NAMES } from '../shared/constants.ts';
import type { AgentPolicy, AgentView } from '../shared/decision.ts';
import { agentErrorText, type AgentResult, type Gateway } from '../shared/gateway.ts';
import { capInput } from './core/input-cap.ts';
import type { HookDeps } from './deps.ts';
import { DualRateLimiter, ThrottledLog } from './limits.ts';

const MINUTE_MS = 60_000;
const DECIDE_PER_AGENT = 10;
const DECIDE_GLOBAL = 60;
const READ_PER_AGENT = 30;
const READ_GLOBAL = 120;
const MAX_DECIDES_IN_FLIGHT = 2;
const DECIDE_TIMEOUT_MS = 20_000;
const DECIDE_BUDGET_MS = 15_000;
const READ_TIMEOUT_MS = 5000;

const [DECIDE, EXPLAIN, POLICIES] = AGENT_TOOL_NAMES;

const POLICY_ID = /^[a-z][a-z0-9_-]{0,63}$/;

const decideInput = z.object({
  policy: z.string().regex(POLICY_ID).describe('Policy id from local_decider_policies'),
  input: z
    .record(z.string(), z.unknown())
    .describe("Structured input; keys follow the policy's inputKeys (see local_decider_policies)"),
});

const explainInput = z.object({
  decisionId: z.uuid().describe('The decisionId a local_decider_decide result returned'),
});

const policiesInput = z.object({});

/**
 * `defineAgentTool` from the SDK only checks the name and returns the definition. It is not
 * imported at runtime so the handlers load under `--conditions=source`; the name rule is tested.
 */
function defineTool<Input extends z.ZodType>(tool: {
  name: string;
  title: string;
  description: string;
  input: Input;
  execute(input: z.output<Input>, context: AgentToolContext): Promise<AgentToolResult>;
}): AgentToolDefinition {
  return tool;
}

/** Options for tests: the clock behind the limiters and the log throttle. */
export interface AgentToolOptions {
  readonly now?: () => number;
}

function fail(message: string): AgentToolResult {
  return { isError: true, text: agentErrorText(message) };
}

function decideLine(view: AgentView): string {
  if (view.failedOpen) {
    return `${view.policy}: no answer (failed open, ${view.action}). Decision ${view.decisionId}.`;
  }
  const confidence =
    view.primary === undefined ? '' : `, confidence ${view.primary.confidence.toFixed(2)}`;
  const mode = view.enforced ? 'enforced' : 'shadow';
  return `${view.policy}: ${view.action} (${mode}${confidence}). Decision ${view.decisionId}.`;
}

function explainLine(view: AgentView): string {
  const primary =
    view.primary === undefined
      ? 'no primary answer'
      : `${view.primary.question} = ${view.primary.answer} (confidence ${view.primary.confidence.toFixed(2)})`;
  const notes = [view.failedOpen ? 'failed open' : '', view.truncated ? 'input truncated' : '']
    .filter((n) => n !== '')
    .join(', ');
  return `${view.policy}: ${view.action}; ${primary}; ${view.enforced ? 'enforced' : 'not enforced'}${notes === '' ? '' : `; ${notes}`}.`;
}

function viewResult(
  result: AgentResult<AgentView>,
  line: (view: AgentView) => string,
): AgentToolResult {
  return result.ok
    ? { text: line(result.value), structuredContent: result.value }
    : fail(result.error);
}

function policiesResult(result: AgentResult<readonly AgentPolicy[]>): AgentToolResult {
  if (!result.ok) {
    return fail(result.error);
  }
  return {
    text: JSON.stringify(result.value),
    structuredContent: { policies: result.value },
  };
}

interface State {
  readonly deps: HookDeps;
  readonly decides: DualRateLimiter;
  readonly reads: DualRateLimiter;
  readonly throttle: ThrottledLog;
  inFlight: number;
}

/** The gateway, or the tool error to return instead (unusable URL, known down). */
async function gatewayOrError(
  deps: HookDeps,
): Promise<{ gateway: Gateway } | { error: AgentToolResult }> {
  if (deps.gatewayKnownDown?.() === true) {
    return { error: fail('local-decider gateway is down') };
  }
  const gateway = await deps.gateway();
  return gateway === null
    ? { error: fail('local-decider gateway is not configured') }
    : { gateway };
}

function limited(state: State, name: string): AgentToolResult {
  state.throttle.emit((line) => state.deps.log(line), `agent tool rate limited: ${name}`);
  return fail('rate limited, retry later');
}

async function withGateway(
  state: State,
  run: (gateway: Gateway) => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  try {
    const found = await gatewayOrError(state.deps);
    return 'error' in found ? found.error : await run(found.gateway);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'local-decider tool failed');
  }
}

async function runDecide(
  state: State,
  input: z.output<typeof decideInput>,
  ctx: { agent: { id: string; cwd: string }; signal: AbortSignal },
): Promise<AgentToolResult> {
  if (!state.decides.allow(ctx.agent.id)) {
    return limited(state, DECIDE);
  }
  if (state.inFlight >= MAX_DECIDES_IN_FLIGHT) {
    return fail('decider busy, retry later');
  }
  state.inFlight += 1;
  try {
    return await withGateway(state, async (gateway) =>
      viewResult(
        await gateway.decideAgent(
          input.policy,
          {
            harness: 'mcp',
            sessionId: ctx.agent.id,
            workspace: { cwd: ctx.agent.cwd },
            input: capInput(input.input),
            budgetMs: DECIDE_BUDGET_MS,
          },
          { signal: ctx.signal, timeoutMs: DECIDE_TIMEOUT_MS },
        ),
        decideLine,
      ),
    );
  } finally {
    state.inFlight -= 1;
  }
}

async function runExplain(
  state: State,
  decisionId: string,
  ctx: { agent: { id: string }; signal: AbortSignal },
): Promise<AgentToolResult> {
  if (!state.reads.allow(ctx.agent.id)) {
    return limited(state, EXPLAIN);
  }
  return withGateway(state, async (gateway) =>
    viewResult(
      await gateway.decision(decisionId, { signal: ctx.signal, timeoutMs: READ_TIMEOUT_MS }),
      explainLine,
    ),
  );
}

async function runPolicies(
  state: State,
  ctx: { agent: { id: string }; signal: AbortSignal },
): Promise<AgentToolResult> {
  if (!state.reads.allow(ctx.agent.id)) {
    return limited(state, POLICIES);
  }
  return withGateway(state, async (gateway) =>
    policiesResult(await gateway.agentPolicies({ signal: ctx.signal, timeoutMs: READ_TIMEOUT_MS })),
  );
}

/** The three tools, with one set of limiters shared by every agent that gets them. */
export function agentTools(deps: HookDeps, options: AgentToolOptions = {}): AgentToolDefinition[] {
  const now = options.now ?? Date.now;
  const state: State = {
    deps,
    decides: new DualRateLimiter(DECIDE_PER_AGENT, DECIDE_GLOBAL, MINUTE_MS, now),
    reads: new DualRateLimiter(READ_PER_AGENT, READ_GLOBAL, MINUTE_MS, now),
    throttle: new ThrottledLog(MINUTE_MS, now),
    inFlight: 0,
  };
  return [
    defineTool({
      name: DECIDE,
      title: 'Ask the local decider',
      description:
        'Ask the local decision model a fixed-choice question through a policy. Call ' +
        'local_decider_policies first to see the policy ids and the input keys each reads. The ' +
        'answer is advisory and never enforced; it returns the action the policy would take, the ' +
        'deciding question with its answer and confidence, and a decisionId for ' +
        'local_decider_explain. No free text.',
      input: decideInput,
      execute: async (input, ctx) => runDecide(state, input, ctx),
    }),
    defineTool({
      name: EXPLAIN,
      title: 'Explain a local decision',
      description:
        'Explain one decision by its decisionId: the action, the deciding question and answer, ' +
        'whether it was enforced and whether it failed open.',
      input: explainInput,
      execute: async (input, ctx) => runExplain(state, input.decisionId, ctx),
    }),
    defineTool({
      name: POLICIES,
      title: 'List local decider policies',
      description:
        'List the policies you can call: id, description, the input keys each reads, and each ' +
        'question with its options.',
      input: policiesInput,
      execute: async (_input, ctx) => runPolicies(state, ctx),
    }),
  ];
}
