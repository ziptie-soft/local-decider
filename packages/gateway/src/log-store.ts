import type {
  LogRecord,
  OutcomeRecord,
  Scope,
  ShadowRecord,
  UsageRecord,
} from '@ziptie-soft/local-decider-core';

import type { LogCounters } from './counters.ts';

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
  /** Queued and written in a batch shortly after; `findDecision` and reads see it at once. */
  append(record: LogRecord): void;
  /** Write every queued record now. Never throws; a failure leaves them queued for retry. */
  flush(): void;
  /** The recorded decision with this id, if it is still stored. */
  findDecision(decisionId: string): ShadowRecord | undefined;
  /** Every outcome reported for a decision, in the order they were appended. */
  findOutcomes(decisionId: string): OutcomeRecord[];
  /** Every usage row reported for a decision, verified or not. */
  findUsage(decisionId: string): UsageRecord[];
  /** The decisions made for one harness tool call (a call can have several), oldest first. */
  findByCall(callId: string, limit?: number): ShadowRecord[];
  read(): LogRecord[];
  readRecent(maxAgeDays: number, now?: number): LogRecord[];
  /**
   * The stats window as a stream, with probe decisions and other scopes filtered out. Consume it
   * synchronously.
   */
  iterateRecent(maxAgeDays: number, scope?: Scope, now?: number): Iterable<LogRecord>;
  /** Precedent evidence: keyed decisions, verified labels and configured unverified vetoes. */
  readVerifiedPrecedent(maxAgeDays: number, now?: number): LogRecord[];
  /** Chunked and cooperative; resolves to the number of decisions deleted. */
  prune(retainDays: number, now?: number): Promise<number>;
  /** Failed flushes and records dropped over the queue limit since opening, for `/health`. */
  counters?(): LogCounters;
  close(): void;
}
