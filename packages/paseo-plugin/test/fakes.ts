import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRefLike, AppendItem, HookDeps, PaseoLike } from '../server/deps.ts';
import type {
  AgentDecideRequest,
  AgentPolicy,
  AgentView,
  DecideResponse,
  UsageReport,
} from '../shared/decision.ts';
import type { AgentResult, Gateway } from '../shared/gateway.ts';
import type { DeciderSettings } from '../shared/settings.ts';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ld-${prefix}-`));
}

export function settings(overrides: Partial<DeciderSettings> = {}): DeciderSettings {
  return {
    gatewayUrl: 'http://127.0.0.1:8765',
    useSocket: true,
    modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'shadow' },
    presets: {
      fast: { model: '', modeId: '' },
      standard: { model: '', modeId: '' },
      deep: { model: '', modeId: '' },
    },
    agentTools: false,
    dailyReview: false,
    preloadOnStart: false,
    sidebar: { position: 'footer', label: 'full', press: 'popover' },
    rows: { show: 'all', details: true, feedback: true },
    ...overrides,
  };
}

export function response(overrides: Partial<DecideResponse> = {}): DecideResponse {
  return {
    decisionId: 'd-1',
    policy: 'turn-outcome',
    mode: 'shadow',
    action: 'log',
    enforced: false,
    answers: {
      outcome: {
        type: 'choice',
        answer: 'done',
        probabilities: { done: 0.9, stuck: 0.1 },
        confidence: 0.8,
      },
    },
    rule: 0,
    engine: 'strands-decider',
    model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    latencyMs: 120,
    cached: false,
    ...overrides,
  };
}

export interface FakeGateway extends Gateway {
  readonly calls: {
    policy: string;
    input: Readonly<Record<string, unknown>>;
    sessionId?: string;
    timeoutMs?: number;
  }[];
  readonly outcomes: { decisionId: string; outcome: string; source: string }[];
  readonly usage: UsageReport[];
  /** Every mutating engine call, by name, with its input. */
  readonly posts: { name: string; input: unknown }[];
  /** Agent-tool reads: every call, and handlers a test replaces. */
  readonly agentCalls: {
    name: string;
    policy?: string;
    id?: string;
    request?: AgentDecideRequest;
  }[];
  agentDecide: (policy: string, request: AgentDecideRequest) => Promise<AgentResult<AgentView>>;
  agentDecision: (id: string) => Promise<AgentResult<AgentView>>;
  agentPolicyList: () => Promise<AgentResult<readonly AgentPolicy[]>>;
  /** `review` reads: every call, and the body a test replaces. */
  readonly reviewCalls: { days: number; limit: number }[];
  reviewBody: () => Promise<unknown>;
}

export function agentView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    decisionId: '11111111-1111-4111-8111-111111111111',
    policy: 'turn-outcome',
    action: 'log',
    enforced: false,
    primary: { question: 'outcome', answer: 'done', confidence: 0.91 },
    failedOpen: false,
    truncated: false,
    ...overrides,
  };
}

export function fakeGateway(
  decide: (policy: string) => DecideResponse | null | Promise<DecideResponse | null>,
): FakeGateway {
  const calls: FakeGateway['calls'] = [];
  const outcomes: FakeGateway['outcomes'] = [];
  const usage: UsageReport[] = [];
  const posts: FakeGateway['posts'] = [];
  const record =
    (name: string) =>
    async (input: unknown): Promise<{ ok: true; body: unknown }> => {
      posts.push({ name, input });
      return { ok: true, body: {} };
    };
  const agentCalls: FakeGateway['agentCalls'] = [];
  const reviewCalls: FakeGateway['reviewCalls'] = [];
  const fake: FakeGateway = {
    baseUrl: 'http://127.0.0.1:8765',
    bearer: false,
    calls,
    agentCalls,
    agentDecide: async () => ({ ok: true, value: agentView() }),
    agentDecision: async () => ({ ok: true, value: agentView() }),
    agentPolicyList: async () => ({ ok: true, value: [] }),
    reviewCalls,
    reviewBody: async () => null,
    async review(days, limit) {
      reviewCalls.push({ days, limit });
      return fake.reviewBody();
    },
    async decideAgent(policy, request) {
      agentCalls.push({ name: 'decideAgent', policy, request });
      return fake.agentDecide(policy, request);
    },
    async decision(id) {
      agentCalls.push({ name: 'decision', id });
      return fake.agentDecision(id);
    },
    async agentPolicies() {
      agentCalls.push({ name: 'agentPolicies' });
      return fake.agentPolicyList();
    },
    outcomes,
    usage,
    posts,
    async decide(policy, request, options) {
      calls.push({
        policy,
        input: request.input,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      const signal = options?.signal;
      if (signal === undefined) {
        return decide(policy);
      }
      // Like the real client: an abort ends the call with null.
      const aborted = new Promise<null>((resolve) => {
        if (signal.aborted) {
          resolve(null);
        }
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      return Promise.race([Promise.resolve(decide(policy)), aborted]);
    },
    async reportOutcome(decisionId, outcome, source) {
      outcomes.push({ decisionId, outcome, source });
      return true;
    },
    async reportUsage(report) {
      usage.push(report);
      return true;
    },
    health: async () => ({ status: 'ok', engine: 'strands-decider', model: 'm', p50Ms: 100 }),
    engines: async () => ({}),
    stats: async () => ({}),
    selectEngine: record('selectEngine'),
    setSelectionMode: async (mode, family) =>
      record('setSelectionMode')(family === undefined ? { mode } : { mode, family }),
    benchmark: async () => ({ state: 'idle' }),
    benchmarkStart: async (body) => {
      posts.push({ name: 'benchmarkStart', input: body });
      return { ok: true, body: { state: 'running', total: 2 } };
    },
    benchmarkCancel: async () => {
      posts.push({ name: 'benchmarkCancel', input: {} });
      return { ok: true, body: { state: 'cancelling' } };
    },
    downloadModel: record('downloadModel'),
    removeModel: record('removeModel'),
    validateEngine: record('validateEngine'),
    saveEngineConnection: record('saveEngineConnection'),
    discoverServers: record('discoverServers'),
    setPath: async (key, value) => record('setPath')({ key, value }),
    engineLoad: record('engineLoad'),
    setLifecycle: record('setLifecycle'),
    setPolicyMode: record('setPolicyMode'),
    setPolicySelection: async (policy, selection) =>
      record('setPolicySelection')({ policy, selection }),
    policies: async () => [
      {
        id: 'permission',
        mode: 'shadow',
        description: 'p',
        routes: [],
        variants: ['permission'],
        thresholds: [
          {
            key: 'verdict.allow',
            question: 'verdict',
            answer: 'allow',
            action: 'allow',
            kind: 'minProbability',
            default: 0.95,
            value: 0.9,
            floor: 0.8,
          },
        ],
      },
      {
        id: 'routing',
        mode: 'act',
        description: 'Tiers.',
        routes: ['fast', 'deep'],
        variant: 'routing-budget',
        variants: ['routing', 'routing-budget'],
      },
      {
        id: 'routing-budget',
        description: 'Cheap first.',
        routes: ['cheap'],
        variantOf: 'routing',
      },
    ],
    setPolicyVariant: async (policy, variant) => record('setPolicyVariant')({ policy, variant }),
    setPolicyThresholds: async (policy, thresholds) =>
      record('setPolicyThresholds')({ policy, thresholds }),
    config: async () => ({
      file: '/home/u/.config/local-decider/config.yaml',
      config: { routing: { presets: { paseo: { cheap: { model: 'claude/haiku' } } } } },
    }),
    setRoutingPreset: async (update) => record('setRoutingPreset')(update),
    policyPrompt: async (policy) =>
      policy === 'routing'
        ? { prompt: '# Write a policy', cwd: '/home/u/.config/local-decider' }
        : null,
    reloadPolicies: async () => {
      posts.push({ name: 'reloadPolicies', input: {} });
      return { ok: true, body: { policies: ['permission', 'routing', 'routing-budget'] } };
    },
  };
  return fake;
}

export function deps(s: DeciderSettings, gateway: Gateway | null): HookDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    settings: async () => s,
    gateway: async () => gateway,
    log: (m) => logs.push(m),
  };
}

export interface FakeAgent extends AgentRefLike {
  readonly appended: AppendItem[];
  readonly responses: unknown[];
}

export function fakePaseo(
  items: readonly { item: AgentTimelineItem; turnId?: string }[],
  respond: () => Promise<void> = async () => {},
): PaseoLike & { agent: FakeAgent } {
  const appended: AppendItem[] = [];
  const responses: unknown[] = [];
  const agent: FakeAgent = {
    appended,
    responses,
    timeline: {
      refetch: async () => ({ entries: items }),
      append: async (item) => {
        appended.push(item);
        return { seq: appended.length, epoch: 'e' };
      },
    },
    respondToPermission: async (options) => {
      responses.push(options);
      await respond();
    },
  };
  return { agent, agents: { ref: () => agent } };
}

export const ctx = (paseo: PaseoLike): { paseo: PaseoLike; signal: AbortSignal } => ({
  paseo,
  signal: new AbortController().signal,
});

/** Run `body` with `LOCAL_DECIDER_CONFIG_DIR` set to `dir`, restoring it afterwards. */
export async function withConfigDir(dir: string, body: () => Promise<void>): Promise<void> {
  const before = process.env['LOCAL_DECIDER_CONFIG_DIR'];
  process.env['LOCAL_DECIDER_CONFIG_DIR'] = dir;
  try {
    await body();
  } finally {
    if (before === undefined) {
      delete process.env['LOCAL_DECIDER_CONFIG_DIR'];
    } else {
      process.env['LOCAL_DECIDER_CONFIG_DIR'] = before;
    }
  }
}
