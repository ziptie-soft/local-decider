/** `agent.create.after` → the routing decision as a row on the new agent's timeline. */
import { rowVisible, toRowData } from '../shared/row.ts';
import type { HookDeps, PaseoLike } from './deps.ts';
import { appendRow } from './timeline.ts';
import { pluginEnforces } from './turn.ts';
import type { RoutingLink } from './usage.ts';

/**
 * Waits for the link's decision (bounded by routing's own timeouts: 2 s in act, 30 s in shadow),
 * then appends its row. The hook is a notification, so this adds no latency to agent creation;
 * callers run it detached and log a failure (it fails open).
 */
export async function drawRoutingRow(
  deps: Pick<HookDeps, 'settings'>,
  paseo: PaseoLike,
  agentId: string,
  link: RoutingLink,
): Promise<void> {
  const res = await link.decision;
  if (res === null) {
    return;
  }
  const settings = await deps.settings();
  const mode = settings.modes.routing;
  if (mode === 'off') {
    return;
  }
  const row = toRowData(res, {
    source: 'routing',
    key: res.decisionId,
    enforced: pluginEnforces(res, mode),
    applied: link.applied,
    pluginMode: mode,
    ...(link.note === null ? {} : { note: link.note }),
  });
  if (rowVisible(row, settings.rows.show)) {
    await appendRow(paseo.agents.ref(agentId), row);
  }
}
