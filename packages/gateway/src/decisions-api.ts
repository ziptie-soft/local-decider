import { CALL_ID, type ShadowRecord } from '@ziptie-soft/local-decider-core';

import { agentView, explainDecision, type ExplainContext, type ExplainView } from './explain.ts';
import type { LogStore } from './log-store.ts';
import type { LoadedPolicy } from './policies.ts';

/** What `GET /v1/decisions` reads: the store and the policies as the gateway applies them now. */
export interface DecisionsSource {
  readonly log: LogStore;
  readonly policies: ReadonlyMap<string, LoadedPolicy>;
  /** Threshold overrides in effect per policy id (only values that differ from the file). */
  readonly overrides: (id: string) => Readonly<Record<string, number>>;
}

export interface DecisionsQuery {
  /** `/v1/decisions/<id>`: one decision. */
  readonly id?: string | undefined;
  /** `?call=<callId>`: every decision of that tool call. */
  readonly call?: string | null | undefined;
  /** `?view=agent`: the projection an agent may see. */
  readonly view?: string | null | undefined;
}

export type DecisionsResult = readonly [status: number, body: unknown];

function contextOf(source: DecisionsSource): ExplainContext {
  return {
    policies: source.policies,
    overrides: Object.fromEntries(
      [...source.policies.keys()].map((id) => [id, source.overrides(id)]),
    ),
  };
}

function viewOf(source: DecisionsSource, record: ShadowRecord): ExplainView {
  const { log } = source;
  return explainDecision(
    record,
    log.findOutcomes(record.decisionId),
    log.findUsage(record.decisionId),
    contextOf(source),
  );
}

/** Pure of HTTP: the status and JSON body for one query; the caller has already checked auth. */
export function decisionsResponse(source: DecisionsSource, query: DecisionsQuery): DecisionsResult {
  const { id, call, view } = query;
  if (view !== null && view !== undefined && view !== 'agent') {
    return [400, { error: 'view must be agent, or absent for the full explanation' }];
  }
  const shape = (record: ShadowRecord): unknown => {
    const full = viewOf(source, record);
    return view === 'agent' ? agentView(full) : full;
  };
  if (id !== undefined) {
    const record = source.log.findDecision(id);
    return record === undefined ? [404, { error: 'unknown decision' }] : [200, shape(record)];
  }
  if (call === null || call === undefined) {
    return [400, { error: 'call=<call id> required' }];
  }
  if (!CALL_ID.test(call)) {
    return [404, { error: 'unknown call' }];
  }
  const records = source.log.findByCall(call);
  return records.length === 0 ? [404, { error: 'unknown call' }] : [200, records.map(shape)];
}
