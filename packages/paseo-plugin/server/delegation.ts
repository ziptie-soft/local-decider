/**
 * Who is creating an agent? `agent.create.before` carries no labels and no parent, so a creator
 * that is another agent (a `create_agent` tool call) is found by correlation: a running agent
 * whose timeline tail holds a running `create_agent` call with the new agent's title. A delegated
 * agent keeps the model its creator chose. Any doubt (no match is `user`; an error, an abort or a
 * missing API is `unknown`) only ever skips a route.
 */
import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';

import { asRecord } from './core/subject.ts';

export type Creator = 'delegated' | 'user' | 'unknown';

/**
 * The running agents considered as possible parents, most recently updated first. A parent blocked
 * in its `create_agent` call is not the most recently updated, so with more running agents than
 * this the answer is `unknown`, never `user`.
 */
const MAX_PARENTS = 8;
const TAIL_ITEMS = 6;

/** The slice of `PaseoApi.agents` the correlation needs. */
export interface DelegationPaseo {
  readonly agents?: {
    list(options: {
      filter: { statuses: ['running'] };
      sort: [{ key: 'updated_at'; direction: 'desc' }];
      page: { limit: number };
    }): Promise<{ readonly entries: readonly { readonly agent: { readonly id: string } }[] }>;
    ref(agentId: string): {
      readonly timeline: {
        refetch(options: { direction: 'tail'; limit: number }): Promise<{
          readonly entries: readonly { readonly item: AgentTimelineItem }[];
        }>;
      };
    };
  };
}

/** The tool's input: Paseo puts it in `detail.input` for tools it has no richer detail for. */
function callInput(item: AgentTimelineItem): Record<string, unknown> | undefined {
  if (item.type !== 'tool_call') {
    return undefined;
  }
  const detail = asRecord(item.detail);
  return asRecord(detail?.['input']) ?? asRecord((item as { input?: unknown }).input);
}

/** True for a running `create_agent` call (`mcp__paseo__create_agent`, `paseo.create_agent`) with this title. */
function isCreateCallFor(item: AgentTimelineItem, title: string): boolean {
  if (
    item.type !== 'tool_call' ||
    item.status !== 'running' ||
    !item.name.endsWith('create_agent')
  ) {
    return false;
  }
  const given = callInput(item)?.['title'];
  return typeof given === 'string' && given.trim() === title;
}

/** The ids to inspect, and whether more agents were running than that. */
async function parentIds(
  agents: NonNullable<DelegationPaseo['agents']>,
): Promise<{ ids: string[]; overflow: boolean }> {
  const listed = await agents.list({
    filter: { statuses: ['running'] },
    sort: [{ key: 'updated_at', direction: 'desc' }],
    page: { limit: MAX_PARENTS + 1 },
  });
  return {
    ids: listed.entries.slice(0, MAX_PARENTS).map((e) => e.agent.id),
    overflow: listed.entries.length > MAX_PARENTS,
  };
}

async function hasCreateCall(
  agents: NonNullable<DelegationPaseo['agents']>,
  id: string,
  title: string,
): Promise<boolean> {
  const page = await agents.ref(id).timeline.refetch({ direction: 'tail', limit: TAIL_ITEMS });
  return page.entries.some((e) => isCreateCallFor(e.item, title));
}

async function correlate(
  agents: NonNullable<DelegationPaseo['agents']>,
  title: string,
): Promise<Creator> {
  const { ids, overflow } = await parentIds(agents);
  const found = await Promise.all(ids.map(async (id) => hasCreateCall(agents, id, title)));
  if (found.includes(true)) {
    return 'delegated';
  }
  return overflow ? 'unknown' : 'user';
}

/** Never rejects; `unknown` when the signal aborts first. */
export async function creatorOf(
  paseo: DelegationPaseo | undefined,
  title: string | null | undefined,
  signal: AbortSignal,
): Promise<Creator> {
  const agents = paseo?.agents;
  if (agents === undefined || signal.aborted) {
    return 'unknown';
  }
  const wanted = (title ?? '').trim();
  if (wanted === '') {
    return 'user';
  }
  const aborted = new Promise<Creator>((resolve) => {
    signal.addEventListener('abort', () => resolve('unknown'), { once: true });
  });
  try {
    return await Promise.race([correlate(agents, wanted), aborted]);
  } catch {
    return 'unknown';
  }
}
