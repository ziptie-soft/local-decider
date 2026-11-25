/**
 * The session context a gate decision needs: the task, a short transcript and whether the user has
 * spoken. Read from pi's `buildContextEntries()`; never throws.
 */
import type { PiContext, PiMessage, PiSessionEntry } from './pi-types.ts';

export interface SessionContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly task?: string;
  readonly history?: string;
  readonly hasRecentUserContext: boolean;
}

const HISTORY_MESSAGES = 6;
const HISTORY_CHARS = 6000;
const LINE_CHARS = 600;
const TASK_CHARS = 1500;

interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - Math.max(0, max - 1))}`;
}

/** Text parts of a message's content, joined; images, thinking and tool calls are skipped. */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content as readonly unknown[]) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p?.type === 'text' && typeof p.text === 'string') {
      parts.push(p.text);
    }
  }
  return parts.join('\n');
}

function turnOf(message: PiMessage): Turn | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return undefined;
  }
  const text = textOf(message.content).trim();
  return text === '' ? undefined : { role: message.role, text };
}

function turnsOf(entries: readonly PiSessionEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    if (entry.type === 'message' && 'message' in entry) {
      const turn = turnOf(entry.message);
      if (turn !== undefined) {
        turns.push(turn);
      }
    }
  }
  return turns;
}

function renderHistory(turns: readonly Turn[]): string {
  const lines = turns
    .slice(-HISTORY_MESSAGES)
    .map((t) => `${t.role}: ${head(oneLine(t.text), LINE_CHARS)}`);
  return tail(lines.join('\n'), HISTORY_CHARS);
}

/** `First request: …` and, when the user steered later, `Latest request: …` (as the hooks do). */
function renderTask(users: readonly Turn[]): string | undefined {
  const first = users[0]?.text.trim() ?? '';
  const latest = users.at(-1)?.text.trim() ?? '';
  if (first === '') {
    return undefined;
  }
  const lines = [`First request: ${head(first, TASK_CHARS)}`];
  if (latest !== '' && latest !== first) {
    lines.push(`Latest request: ${head(latest, TASK_CHARS)}`);
  }
  return lines.join('\n');
}

export function readContext(ctx: PiContext): SessionContext {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = ctx.sessionManager.getCwd();
  try {
    const turns = turnsOf(ctx.sessionManager.buildContextEntries());
    const users = turns.filter((t) => t.role === 'user');
    const task = renderTask(users);
    const history = renderHistory(turns);
    return {
      sessionId,
      cwd,
      ...(task === undefined ? {} : { task }),
      ...(history === '' ? {} : { history }),
      hasRecentUserContext: users.length > 0,
    };
  } catch {
    return { sessionId, cwd, hasRecentUserContext: false };
  }
}
