import type { LogRecord, ShadowRecord } from '@ziptie-soft/local-decider-core';

/**
 * Decisions asked through MCP or the CLI are probes, not harness tool calls: they may be logged
 * but never feed agreement, savings, calibration or precedent.
 */
export function isProbeDecision(record: ShadowRecord): boolean {
  return record.harness === 'mcp' || record.harness === 'cli';
}

/** Durable decision, outcome and usage storage; precedent and calibration are rebuilt from it. */
export interface LogStore {
  append(record: LogRecord): void;
  read(): LogRecord[];
  readRecent(maxAgeDays: number, now?: number): LogRecord[];
  /** Precedent evidence: keyed decisions, verified labels and configured unverified vetoes. */
  readVerifiedPrecedent(maxAgeDays: number, now?: number): LogRecord[];
  prune(retainDays: number, now?: number): number;
  close(): void;
}
