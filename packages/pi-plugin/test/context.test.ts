import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readContext } from '../extension/context.ts';
import type { PiContext, PiSessionEntry } from '../extension/pi-types.ts';

function msg(message: unknown, id = 'e'): PiSessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '', message } as PiSessionEntry;
}

function ctxOf(entries: () => readonly PiSessionEntry[]): PiContext {
  return {
    cwd: '/w',
    sessionManager: {
      getSessionId: () => 's1',
      getCwd: () => '/work/app',
      buildContextEntries: entries,
    },
  } as unknown as PiContext;
}

test('task, history and user context from message entries', () => {
  const sc = readContext(
    ctxOf(() => [
      { type: 'model_change', id: 'm', parentId: null, timestamp: '' },
      msg({ role: 'user', content: 'fix the\n build', timestamp: 1 }),
      msg({
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'secret' },
          { type: 'text', text: 'on it' },
          { type: 'toolCall', name: 'bash' },
        ],
        timestamp: 2,
      }),
      msg({ role: 'toolResult', content: [{ type: 'text', text: 'noise' }], timestamp: 3 }),
      msg({
        role: 'user',
        content: [
          { type: 'image', data: 'x', mimeType: 'image/png' },
          { type: 'text', text: 'also lint' },
        ],
        timestamp: 4,
      }),
    ]),
  );
  assert.equal(sc.sessionId, 's1');
  assert.equal(sc.cwd, '/work/app');
  assert.equal(sc.hasRecentUserContext, true);
  assert.equal(sc.task, 'First request: fix the\n build\nLatest request: also lint');
  assert.equal(sc.history, 'user: fix the build\nassistant: on it\nuser: also lint');
});

test('history keeps the last six messages within 6000 chars', () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    msg({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, timestamp: i }),
  );
  const sc = readContext(ctxOf(() => entries));
  assert.equal(sc.history?.split('\n').length, 6);
  assert.ok(sc.history?.startsWith('user: m4'));
  const long = readContext(
    ctxOf(() =>
      Array.from({ length: 6 }, (_, i) =>
        msg({ role: 'user', content: `${i}${'x'.repeat(2000)}`, timestamp: i }),
      ),
    ),
  );
  assert.ok((long.history?.length ?? 0) <= 6000);
});

test('no user message means no recent user context', () => {
  const sc = readContext(
    ctxOf(() => [
      msg({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }),
    ]),
  );
  assert.equal(sc.hasRecentUserContext, false);
  assert.equal(sc.task, undefined);
});

test('an exception yields the bare context', () => {
  const sc = readContext(
    ctxOf(() => {
      throw new Error('boom');
    }),
  );
  assert.deepEqual(sc, { sessionId: 's1', cwd: '/work/app', hasRecentUserContext: false });
});
