import type { LogRecord, ShadowRecord } from '@ziptie-soft/local-decider-core';

/**
 * Decisions asked through MCP or the CLI are probes, not harness tool calls: they may be logged
 * but never feed agreement, savings, calibration or precedent.
 */
export function isProbeDecision(record: ShadowRecord): boolean {
  return record.harness === 'mcp' || record.harness === 'cli';
}

/**
 * The engine saw only part of a state section, so its answers say little about the full request:
 * such decisions are counted but never feed calibration.
 */
export function isTruncatedDecision(record: ShadowRecord): boolean {
  return record.truncated !== undefined && record.truncated.length > 0;
}

/** Durable decision, outcome and usage storage; precedent and calibration are rebuilt from it. */
export interface LogStore {
  append(record: LogRecord): void;
  /** The recorded decision with this id, if it is still stored. */
  findDecision(decisionId: string): ShadowRecord | undefined;
  read(): LogRecord[];
  readRecent(maxAgeDays: number, now?: number): LogRecord[];
  /** Precedent evidence: keyed decisions, verified labels and configured unverified vetoes. */
  readVerifiedPrecedent(maxAgeDays: number, now?: number): LogRecord[];
  prune(retainDays: number, now?: number): number;
  close(): void;
}
