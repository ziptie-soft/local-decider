import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createExtension, FLAG_NAME, PI_GUIDE_URL, STATUS_KEY } from '../extension/index.ts';
import type {
  PiAPI,
  PiCommandOptions,
  PiContext,
  PiFlagOptions,
  PiProviderConfig,
} from '../extension/pi-types.ts';

type AnyHandler = (event: unknown, ctx: PiContext) => unknown;

interface Fake {
  pi: PiAPI;
  handlers: Map<string, AnyHandler>;
  flags: Map<string, PiFlagOptions>;
  commands: Map<string, PiCommandOptions>;
  providers: Map<string, PiProviderConfig>;
  flagValue: { current: string | undefined };
}

function fakePi(): Fake {
  const handlers = new Map<string, AnyHandler>();
  const flags = new Map<string, PiFlagOptions>();
  const commands = new Map<string, PiCommandOptions>();
  const providers = new Map<string, PiProviderConfig>();
  const flagValue: { current: string | undefined } = { current: undefined };
  const pi: PiAPI = {
    on: ((name: string, handler: AnyHandler) => {
      handlers.set(name, handler);
      return () => {};
    }) as PiAPI['on'],
    registerFlag: (name, options) => void flags.set(name, options),
    getFlag: () => flagValue.current,
    registerCommand: (name, options) => void commands.set(name, options),
    registerProvider: (name, config) => void providers.set(name, config),
  };
  return { pi, handlers, flags, commands, providers, flagValue };
}

interface Ui {
  ctx: PiContext;
  notes: { message: string; level: string | undefined }[];
  status: (string | undefined)[];
}

function fakeCtx(): Ui {
  const notes: Ui['notes'] = [];
  const status: Ui['status'] = [];
  const ctx = {
    ui: {
      notify: (message: string, level?: string) => void notes.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, STATUS_KEY);
        status.push(text);
      },
      select: async () => undefined,
    },
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp',
    sessionManager: {
      getSessionId: () => 's1',
      getCwd: () => '/tmp',
      buildContextEntries: () => [],
    },
  } as unknown as PiContext;
  return { ctx, notes, status };
}

function fetchStub(ok: boolean | 'down'): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stub = (async (url: string | URL | Request) => {
    calls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    if (ok === false) throw new Error('down');
    return new Response(JSON.stringify({ status: ok === 'down' ? 'down' : 'ok' }), { status: 200 });
  }) as typeof fetch;
  return { fetch: stub, calls };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Setup {
  fake: Fake;
  net: { fetch: typeof fetch; calls: string[] };
  ui: Ui;
  launches: () => number;
}

function setup(env: Record<string, string> = {}, ok: boolean | 'down' = true): Setup {
  const fake = fakePi();
  const net = fetchStub(ok);
  let launches = 0;
  createExtension({
    env,
    fetch: net.fetch,
    platform: 'linux',
    now: () => 0,
    launch: async () => {
      launches++;
      return { ok: false, status: 'not-installed', message: 'gateway not installed' };
    },
  })(fake.pi);
  return { fake, net, ui: fakeCtx(), launches: () => launches };
}

async function start(s: Setup): Promise<void> {
  await s.fake.handlers.get('session_start')?.(
    { type: 'session_start', reason: 'startup' },
    s.ui.ctx,
  );
  await tick();
}

function run(s: Setup, args: string): unknown {
  return s.fake.commands.get('local-decider')?.handler(args, s.ui.ctx);
}

test('registration: flag, tool_call, command, provider, no network', () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called++;
    throw new Error('network');
  };
  try {
    const fake = fakePi();
    createExtension({ env: {} })(fake.pi);
    assert.equal(fake.flags.get(FLAG_NAME)?.type, 'string');
    assert.ok(fake.handlers.has('tool_call'));
    assert.ok(fake.handlers.has('session_start'));
    assert.ok(fake.handlers.has('session_shutdown'));
    assert.ok(fake.commands.has('local-decider'));
    assert.ok(fake.providers.has('local-decider'));
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('session_start sets status and checks health in the background', async () => {
  const s = setup();
  await start(s);
  assert.deepEqual(s.ui.status, ['ld: guard']);
  assert.deepEqual(s.net.calls, ['http://127.0.0.1:8765/health']);
  assert.equal(s.ui.notes.length, 0);
});

test('invalid mode env warns and turns off', async () => {
  const s = setup({ LOCAL_DECIDER_PI_MODE: 'bogus' });
  await start(s);
  assert.equal(s.ui.notes[0]?.level, 'warning');
  assert.match(s.ui.notes[0]?.message ?? '', /invalid value/);
  assert.deepEqual(s.ui.status, ['ld: off']);
});

test('the flag is read at session_start', async () => {
  const s = setup();
  s.fake.flagValue.current = 'approve';
  await start(s);
  assert.deepEqual(s.ui.status, ['ld: approve']);
});

test('health failure sets ld: offline', async () => {
  const s = setup({}, false);
  await start(s);
  assert.deepEqual(s.ui.status, ['ld: guard', 'ld: starting', 'ld: offline']);
  assert.equal(s.launches(), 1);
  await run(s, '');
  assert.match(s.ui.notes.at(-1)?.message ?? '', /gateway offline/);
});

test('shows the setup guide once after repeated failing health checks in one session', async () => {
  const s = setup({}, false);
  await start(s);
  await start(s);
  const guideNotes = s.ui.notes.filter(
    (note) => note.level === 'warning' && note.message.includes(`Setup guide: ${PI_GUIDE_URL}`),
  );
  assert.equal(guideNotes.length, 1);
});

test('shows the setup guide again after a new session starts', async () => {
  const s = setup({}, false);
  await start(s);
  await s.fake.handlers.get('session_shutdown')?.(
    { type: 'session_shutdown', reason: 'new' },
    s.ui.ctx,
  );
  await start(s);
  const guideNotes = s.ui.notes.filter(
    (note) => note.level === 'warning' && note.message.includes(`Setup guide: ${PI_GUIDE_URL}`),
  );
  assert.equal(guideNotes.length, 2);
});

test('a reachable gateway with status down reports ld: down', async () => {
  const s = setup({}, 'down');
  await start(s);
  assert.deepEqual(s.ui.status, ['ld: guard', 'ld: starting', 'ld: down']);
  assert.equal(s.launches(), 1);
});

test('automatic launch is attempted at most once per pi process', async () => {
  const s = setup({}, false);
  await start(s);
  await s.fake.handlers.get('session_shutdown')?.(
    { type: 'session_shutdown', reason: 'new' },
    s.ui.ctx,
  );
  await start(s);
  assert.equal(s.launches(), 1);
});

test('command without args reports state and never the token', async () => {
  const s = setup({ LOCAL_DECIDER_TOKEN: 'sekret-token' });
  await start(s);
  await run(s, '');
  const message = s.ui.notes.at(-1)?.message ?? '';
  assert.equal(
    message,
    'local-decider: mode guard · http://127.0.0.1:8765 · gateway ok · last decision none',
  );
  assert.ok(!message.includes('sekret'));
});

test('describe includes the setup guide offline and omits it when the gateway is ok', async () => {
  const offline = setup({}, false);
  await start(offline);
  await run(offline, '');
  assert.ok((offline.ui.notes.at(-1)?.message ?? '').includes(`setup guide ${PI_GUIDE_URL}`));

  const healthy = setup();
  await start(healthy);
  await run(healthy, '');
  assert.ok(!(healthy.ui.notes.at(-1)?.message ?? '').includes(PI_GUIDE_URL));
});

test('command mode sets an override; invalid and unknown input notify', async () => {
  const s = setup();
  await start(s);
  await run(s, 'mode approve');
  assert.equal(s.ui.status.at(-1), 'ld: approve');
  await run(s, 'mode off');
  assert.equal(s.ui.status.at(-1), 'ld: off');
  await run(s, 'mode nope');
  assert.equal(s.ui.notes.at(-1)?.level, 'warning');
  assert.equal(s.ui.status.at(-1), 'ld: off');
  await run(s, 'frobnicate');
  assert.match(s.ui.notes.at(-1)?.message ?? '', /usage/);
});

test('/local-decider start retries the launcher and reports its result', async () => {
  const s = setup();
  await run(s, 'start');
  assert.equal(s.launches(), 1);
  assert.match(s.ui.notes.at(-1)?.message ?? '', /gateway not installed/);
});

test('session_shutdown clears the override', async () => {
  const s = setup();
  await start(s);
  await run(s, 'mode off');
  await s.fake.handlers.get('session_shutdown')?.(
    { type: 'session_shutdown', reason: 'new' },
    s.ui.ctx,
  );
  await start(s);
  assert.equal(s.ui.status.at(-1), 'ld: guard');
});

test('tool_call in off mode allows without calling the gateway', async () => {
  const s = setup({ LOCAL_DECIDER_PI_MODE: 'off' });
  const result = await s.fake.handlers.get('tool_call')?.(
    { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
    s.ui.ctx,
  );
  assert.equal(result, undefined);
  assert.equal(s.net.calls.length, 0);
});

test('UI errors never escape a handler', async () => {
  const s = setup();
  const broken = {
    ...s.ui.ctx,
    ui: {
      notify: () => {
        throw new Error('ui');
      },
      setStatus: () => {
        throw new Error('ui');
      },
    },
  } as unknown as PiContext;
  await s.fake.handlers.get('session_start')?.(
    { type: 'session_start', reason: 'startup' },
    broken,
  );
  await s.fake.commands.get('local-decider')?.handler('mode guard', broken);
});
