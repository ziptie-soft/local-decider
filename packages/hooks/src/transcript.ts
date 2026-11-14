/**
 * Bounded transcript reading. Scan past large metadata/tool records for the first request and
 * recent conversation, with fixed I/O and output ceilings rather than reading the whole file.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { isInjectedText, type Turn } from './turns.ts';

export interface TranscriptSlice {
  /** Bounded conversation records from the start, including the first user request when found. */
  readonly head: string;
  /** Bounded recent conversation records, including the latest user request when found. */
  readonly tail: string;
}

const SLICE_BYTES = 16 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024;
const TURN_CHARS = 1500;

function readAt(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n).toString('utf8');
}

function windowTurns(fd: number, size: number, bytes: number, tail: boolean): Turn[] {
  const start = tail ? size - bytes : 0;
  const offset = Math.max(0, start - 1);
  const text = readAt(fd, offset, bytes + (start > 0 ? 1 : 0));
  const boundary = text.indexOf('\n');
  const first = start > 0 ? (boundary === -1 ? text.length : boundary + 1) : 0;
  const last = !tail && bytes < size ? text.lastIndexOf('\n') + 1 : text.length;
  return parseTurns(last < first ? '' : text.slice(first, last));
}

function scanTurns(fd: number, size: number, bytes: number, tail: boolean): Turn[] {
  const limit = Math.min(size, MAX_SCAN_BYTES);
  let length = Math.min(bytes, limit);
  for (;;) {
    const turns = windowTurns(fd, size, length, tail);
    if (length === limit || turns.some((turn) => turn.role === 'user')) {
      return turns;
    }
    length = Math.min(length * 2, limit);
  }
}

function turnLine(turn: Turn, bytes: number): string {
  let line = '';
  let low = 1;
  let high = Math.min(turn.text.length, TURN_CHARS);
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const content = `${turn.text.slice(0, length)}${length < turn.text.length ? '…' : ''}`;
    const candidate = `${JSON.stringify({ message: { role: turn.role, content } })}\n`;
    if (Buffer.byteLength(candidate) <= bytes) {
      line = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return line;
}

function boundedTurns(turns: readonly Turn[], bytes: number, tail: boolean): string {
  const user = tail
    ? turns.findLastIndex((turn) => turn.role === 'user')
    : turns.findIndex((turn) => turn.role === 'user');
  const indices = Array.from({ length: turns.length }, (_, index) => index);
  if (tail) {
    indices.reverse();
  }
  const selected: { index: number; line: string }[] = [];
  let remaining = bytes;
  for (const index of [user, ...indices.filter((candidate) => candidate !== user)]) {
    const turn = turns[index];
    if (turn !== undefined) {
      const line = turnLine(turn, remaining);
      selected.push({ index, line });
      remaining -= Buffer.byteLength(line);
    }
  }
  return selected
    .toSorted((left, right) => left.index - right.index)
    .map(({ line }) => line)
    .join('');
}

/** Read bounded first/recent conversation; scan windows grow only up to 1 MiB per end. */
export function readSlice(path: string, bytes: number = SLICE_BYTES): TranscriptSlice | null {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      return null;
    }
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const budget = Math.min(bytes, MAX_SCAN_BYTES);
    if (size <= budget) {
      const head = readAt(fd, 0, size);
      return { head, tail: head };
    }
    return {
      head: boundedTurns(scanTurns(fd, size, budget, false), budget, false),
      tail: boundedTurns(scanTurns(fd, size, budget, true), budget, true),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text blocks only: tool calls, tool results and thinking are skipped. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(isRecord)
    .filter(
      (b) => b['type'] === 'text' || b['type'] === 'input_text' || b['type'] === 'output_text',
    )
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
    .join('\n');
}

/** Claude: `{type, message: {role, content}}`; Codex: `{type: 'response_item', payload: {type: 'message', role, content}}`. */
function messageOf(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (entry['isMeta'] === true || entry['isSidechain'] === true) {
    return null;
  }
  const payload = entry['type'] === 'response_item' ? entry['payload'] : entry['message'];
  return isRecord(payload) ? payload : null;
}

function parseLine(line: string): Turn | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = isRecord(entry) ? messageOf(entry) : null;
  const role = msg?.['role'];
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  const text = contentText(msg?.['content']).trim();
  return text === '' || isInjectedText(text) ? null : { role, text };
}

export function parseTurns(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    const turn = line.trim() === '' ? null : parseLine(line);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  return turns;
}
