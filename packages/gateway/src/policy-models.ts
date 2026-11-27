import type { ModelSource } from '@ziptie-soft/local-decider-core';

import type { PolicySelection } from './config.ts';
import type { ServingModel } from './decider.ts';
import type { EngineState } from './engines/types.ts';

/**
 * How a policy's own model is doing: `default` has none, `active` answers, `unavailable` fails
 * over as its `fallback` says, `off` is a policy that is off (its model is not loaded).
 */
export type SelectionStatus = 'default' | 'active' | 'unavailable' | 'off';

/** A policy's own model, as settings and status show it. */
export interface PolicyChoice {
  /** The override, or null for a policy that uses the default model. */
  readonly selection: PolicySelection | null;
  readonly status: SelectionStatus;
  /** Why the override is not answering. */
  readonly reason?: string;
}

/** What a policy that has its own model reports: the choice and the lane that answers for it. */
export interface PolicyModelRow {
  readonly id: string;
  readonly selection: PolicySelection;
  readonly status: SelectionStatus;
  readonly reason?: string;
  readonly fallback: PolicySelection['fallback'];
  /** The engine and model that answer now: its own, or the default model when it fell back. */
  readonly engine: string;
  readonly model: string;
  readonly label: string;
  readonly state: EngineState;
  readonly queueDepth: number;
}

export const DEFAULT_CHOICE: PolicyChoice = { selection: null, status: 'default' };

/** One policy with its own model; `choice.selection` must be set. */
export function modelRow(
  id: string,
  selection: PolicySelection,
  choice: PolicyChoice,
  serving: ServingModel,
  label: string,
): PolicyModelRow {
  return {
    id,
    selection,
    status: choice.status,
    ...(choice.reason === undefined ? {} : { reason: choice.reason }),
    fallback: selection.fallback,
    engine: serving.engine,
    model: serving.model,
    label,
    state: serving.state,
    queueDepth: serving.queueDepth,
  };
}

/** The `policies[]` entries of `GET /v1/engines`. */
export function enginePolicies(rows: readonly PolicyModelRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    id: row.id,
    selection: row.selection,
    status: row.status,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    fallback: row.fallback,
    engine: row.engine,
    model: row.model,
    label: row.label,
    state: row.state,
  }));
}

/** The `policyEngines[]` entries of `/health`. */
export function healthPolicies(rows: readonly PolicyModelRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    policy: row.id,
    engine: row.engine,
    model: row.model,
    label: row.label,
    state: row.state,
    status: row.status,
    fallback: row.fallback,
    queueDepth: row.queueDepth,
  }));
}

/**
 * Reasons whose text holds nothing about this machine. Any other reason (an engine's detail can
 * name a binary path or a URL) is shown on the open surfaces as "<engine> is not available".
 */
const PUBLIC_REASONS = [
  /^too many decisions with their own model \(max \d+\)$/,
  /^fastflowlm serves one model at a time; [\w-]+ already uses \S+$/,
  /^does not fit with the default model$/,
  /^needs ~[\d.]+ GB with the other models loaded; this machine allows ~\d+ GB$/,
  /^the default model cannot switch$/,
  /^its model is not planned yet$/,
  /^benchmark running$/,
  /^device \w+ is not available here$/,
  /^\S+ needs ~[\d.]+ GB; this machine allows ~\d+ GB for the decision model$/,
  /^\S+ is not downloaded yet$/,
];

/** `reason` as an unauthenticated reader may see it. */
function publicReason(reason: string, engine: string): string {
  return PUBLIC_REASONS.some((pattern) => pattern.test(reason))
    ? reason
    : `${engine} is not available`;
}

/** The model fields of a `GET /v1/policies` entry. */
export function policyListFields(
  serving: { readonly engine: string; readonly model: string; readonly source: ModelSource },
  choice: PolicyChoice,
): Record<string, unknown> {
  return {
    engine: serving.engine,
    model: serving.model,
    modelSource: serving.source,
    selection: choice.selection,
    selectionStatus: choice.status,
    ...(choice.reason === undefined || choice.selection === null
      ? {}
      : { selectionReason: publicReason(choice.reason, choice.selection.engine) }),
  };
}
