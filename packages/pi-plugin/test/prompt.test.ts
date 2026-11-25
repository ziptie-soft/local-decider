import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DialogOptions, PiContext } from '../extension/pi-types.ts';
import { askPermission, sanitizeForDisplay } from '../extension/prompt.ts';

type Select = (
  title: string,
  options: string[],
  opts?: DialogOptions,
) => Promise<string | undefined>;

interface Call {
  title: string;
  options: string[];
  opts: DialogOptions | undefined;
}

function makeCtx(
  select: Select,
  extra: { hasUI?: boolean; signal?: AbortSignal } = {},
): { ctx: PiContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: PiContext = {
    ui: {
      select: (title, options, opts) => {
        calls.push({ title, options, opts });
        return select(title, options, opts);
      },
      notify: () => undefined,
      setStatus: () => undefined,
    },
    mode: 'tui',
    hasUI: extra.hasUI ?? true,
    cwd: '/tmp',
    signal: extra.signal,
    sessionManager: {
      getSessionId: () => 's',
      getCwd: () => '/tmp',
      buildContextEntries: () => [],
    },
  };
  return { ctx, calls };
}

const request = { title: 'Run command?', detail: 'rm -rf build' };

const resolvesOnAbort: Select = (_t, _o, opts) =>
  new Promise((resolve) => {
    opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });

const rejectsOnAbort: Select = (_t, _o, opts) =>
  new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

const throwing: Select = async () => {
  throw new Error('ui broke');
};

describe('askPermission', () => {
  it('is unavailable without a UI and never calls select', async () => {
    const { ctx, calls } = makeCtx(async () => 'Allow once', { hasUI: false });
    assert.equal(await askPermission(ctx, request, { timeoutMs: 1000 }), 'unavailable');
    assert.equal(calls.length, 0);
  });

  it('maps Allow once to allow and passes the dialog options', async () => {
    const { ctx, calls } = makeCtx(async () => 'Allow once');
    assert.equal(await askPermission(ctx, request, { timeoutMs: 1000 }), 'allow');
    assert.equal(calls[0]?.title, 'Run command?\nrm -rf build');
    assert.deepEqual(calls[0]?.options, ['Allow once', 'Block']);
    assert.equal(calls[0]?.opts?.blockedKind, 'permission');
    assert.equal(calls[0]?.opts?.timeout, 1000);
    assert.ok(calls[0]?.opts?.signal instanceof AbortSignal);
  });

  it('maps Block and undefined to decline', async () => {
    assert.equal(
      await askPermission(makeCtx(async () => 'Block').ctx, request, { timeoutMs: 1000 }),
      'decline',
    );
    assert.equal(
      await askPermission(makeCtx(async () => undefined).ctx, request, { timeoutMs: 1000 }),
      'decline',
    );
  });

  it('maps a timeout that resolves undefined to decline', async () => {
    assert.equal(
      await askPermission(makeCtx(resolvesOnAbort).ctx, request, { timeoutMs: 20 }),
      'decline',
    );
  });

  it('maps a timeout that rejects to decline', async () => {
    assert.equal(
      await askPermission(makeCtx(rejectsOnAbort).ctx, request, { timeoutMs: 20 }),
      'decline',
    );
  });

  it('maps an abort of ctx.signal to decline, resolving or rejecting', async () => {
    const controller = new AbortController();
    const select: Select = (_t, _o, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        controller.abort();
      });
    const { ctx } = makeCtx(select, { signal: controller.signal });
    assert.equal(await askPermission(ctx, request, { timeoutMs: 5000 }), 'decline');

    const aborted = new AbortController();
    aborted.abort();
    const pre = makeCtx(async () => undefined, { signal: aborted.signal });
    assert.equal(await askPermission(pre.ctx, request, { timeoutMs: 5000 }), 'decline');
  });

  it('declines even when select answers Allow after the signal aborted', async () => {
    const controller = new AbortController();
    const select: Select = async () => {
      controller.abort();
      return 'Allow once';
    };
    const { ctx } = makeCtx(select, { signal: controller.signal });
    assert.equal(await askPermission(ctx, request, { timeoutMs: 5000 }), 'decline');
  });

  it('maps a throw from select to unavailable', async () => {
    assert.equal(
      await askPermission(makeCtx(throwing).ctx, request, { timeoutMs: 5000 }),
      'unavailable',
    );
  });

  it('truncates the title, bounds and cleans the detail', async () => {
    const { ctx, calls } = makeCtx(async () => 'Block');
    await askPermission(
      ctx,
      { title: 'x'.repeat(200), detail: `\u001b[31mred\u001b[0m\u0007${'y'.repeat(5000)}` },
      { timeoutMs: 1000 },
    );
    const [first, rest] = (calls[0]?.title ?? '').split('\n');
    assert.equal(first?.length, 80);
    assert.ok(first?.endsWith('…'));
    assert.ok(rest?.startsWith('redyyy'));
    assert.equal(Array.from(rest ?? '').length, 2000);
  });
});

describe('sanitizeForDisplay', () => {
  it('strips ANSI, OSC and control characters', () => {
    const text = 'a\u001b[1;31mb\u001b[0m\u001b]0;evil\u0007c\u0000d\u007fe\u009bf';
    assert.equal(sanitizeForDisplay(text, 100), 'abcdef');
  });

  it('collapses newlines for single-line text and keeps them for multiline', () => {
    assert.equal(sanitizeForDisplay('a\n\tb\r\nc', 100), 'a b c');
    assert.equal(sanitizeForDisplay('a\n\tb\r\nc', 100, { multiline: true }), 'a\n  b\nc');
  });

  it('truncates by code points with an ellipsis', () => {
    assert.equal(sanitizeForDisplay('😀😀😀😀', 3), '😀😀…');
    assert.equal(sanitizeForDisplay('abc', 3), 'abc');
  });
});
