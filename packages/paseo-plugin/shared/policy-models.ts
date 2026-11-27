/**
 * The decisions that have a model of their own (`policies[]` of `GET /v1/engines`): the schema
 * the engines RPC returns and a lenient parser. A decision absent from the list uses the default
 * model, and an older gateway sends no list at all.
 */
import { z } from 'zod';

import { fields, items, oneOf, runtimeOf, str } from './parse.ts';

const FALLBACKS = ['default', 'open'] as const;
const STATUSES = ['default', 'active', 'unavailable', 'off'] as const;
const STATES = ['stopped', 'starting', 'ready', 'failed'] as const;

/** More than the decision kinds there are; a longer list is cut. */
const MAX_POLICIES = 50;

const selectionSchema = z.object({
  engine: z.string(),
  model: z.string(),
  device: z.string().optional().catch(undefined),
  /** What happens when the model is unavailable; the gateway defaults it to `default`. */
  fallback: z.enum(FALLBACKS).optional().catch(undefined),
});

/** Every field but `id` is read on its own, so one bad value does not drop the catalog. */
export const policyModelSchema = z.object({
  id: z.string(),
  /** The decision's own model; absent when it has none. */
  selection: selectionSchema.optional().catch(undefined),
  /** `active` answers, `unavailable` fails over as `fallback` says, `off` is not loaded. */
  status: z.enum(STATUSES).optional().catch(undefined),
  /** Why the model is not answering. */
  reason: z.string().optional().catch(undefined),
  fallback: z.enum(FALLBACKS).optional().catch(undefined),
  /** The engine and model that answer now: its own, or the default model after a fallback. */
  engine: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  state: z.enum(STATES).optional().catch(undefined),
});

export type PolicyModel = z.output<typeof policyModelSchema>;
type PolicySelection = NonNullable<PolicyModel['selection']>;

/** What `policySelectionRpc` returns: the gateway's verdict on the model, once it accepted one. */
export const selectionResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  status: z.enum(STATUSES).optional(),
  /** Why the new model is not answering yet (status `unavailable`). */
  reason: z.string().optional(),
});

export type SelectionResult = z.output<typeof selectionResultSchema>;

/** `status` and `reason` of a 200 from the selection route; either is left out when unreadable. */
export function parseSelectionOutcome(body: unknown): Pick<SelectionResult, 'status' | 'reason'> {
  const v = fields(body);
  const status = oneOf(v?.['status'], STATUSES);
  const reason = str(v?.['reason']);
  return {
    ...(status === null ? {} : { status }),
    ...(reason === null ? {} : { reason }),
  };
}

function parseSelection(value: unknown): PolicySelection | undefined {
  const runtime = runtimeOf(value);
  if (runtime === null) {
    return undefined;
  }
  return {
    engine: runtime.engine,
    model: runtime.model,
    device: runtime.device ?? undefined,
    fallback: oneOf(runtime.v['fallback'], FALLBACKS) ?? undefined,
  };
}

function parsePolicyModel(value: unknown): PolicyModel | null {
  const v = fields(value);
  const id = str(v?.['id']);
  if (v === null || id === null) {
    return null;
  }
  return {
    id,
    selection: parseSelection(v['selection']),
    status: oneOf(v['status'], STATUSES) ?? undefined,
    reason: str(v['reason']) ?? undefined,
    fallback: oneOf(v['fallback'], FALLBACKS) ?? undefined,
    engine: str(v['engine']) ?? undefined,
    model: str(v['model']) ?? undefined,
    label: str(v['label']) ?? undefined,
    state: oneOf(v['state'], STATES) ?? undefined,
  };
}

/** The decisions with their own model; undefined from a gateway that does not send the list. */
export function parsePolicyModels(value: unknown): PolicyModel[] | undefined {
  return Array.isArray(value) ? items(value, MAX_POLICIES, parsePolicyModel) : undefined;
}

/** Whether any decision's own model is still loading, so the catalog is worth polling. */
export function policyModelsStarting(policies: readonly PolicyModel[] | undefined): boolean {
  return policies?.some((policy) => policy.state === 'starting') ?? false;
}
