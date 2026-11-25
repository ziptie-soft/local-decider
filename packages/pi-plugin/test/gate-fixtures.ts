/** Fakes shared by the gate tests: a recording gateway, a pi context and a gate harness. */
import type { Config, GateMode } from '../extension/config.ts';
import { createGate, type GateDeps } from '../extension/gate.ts';
import type { CallOptions, DecideReply, DecideRequest, Gateway } from '../extension/gateway.ts';
import type {
  DialogOptions,
  PiContext,
  PiSessionEntry,
  ToolCallEvent,
} from '../extension/pi-types.ts';

export const ID = '0b0e7c1a-7a4f-4c1e-9d3b-2f6a8c9e1d24';
const HOME = '/home/u';
export const CWD = '/work/project';
/** A write into pi's agent dir under `HOME`: a config-protection `ask`. */
export const CONFIG_WRITE = `echo x > ${HOME}/.pi/agent/settings.json`;

interface DecideCall {
  policy: string;
  request: DecideRequest;
  options: CallOptions;
}

type DecideImpl = () => Promise<DecideReply | null>;
type ReportImpl = () => Promise<boolean>;

export interface FakeGateway {
  gateway: Gateway;
  decides: DecideCall[];
  reports: { decisionId: string; outcome: string }[];
}

export function fakeGateway(
  decide: DecideImpl,
  report: ReportImpl = async () => true,
): FakeGateway {
  const decides: DecideCall[] = [];
  const reports: { decisionId: string; outcome: string }[] = [];
  const gateway: Gateway = {
    decide: (policy, request, options) => {
      decides.push({ policy, request, options });
      return decide();
    },
    reportOutcome: (decisionId, outcome) => {
      reports.push({ decisionId, outcome });
      return report();
    },
    health: async () => true,
    systemOne: async () => null,
  };
  return { gateway, decides, reports };
}

export function reply(
  action: string,
  enforced: boolean,
  answers?: Record<string, unknown>,
): DecideReply {
  return {
    decisionId: ID,
    policy: 'command-risk',
    mode: enforced ? 'act' : 'shadow',
    action,
    enforced,
    answers: answers ?? { risk: { answer: action, confidence: 0.9123 } },
  };
}

export const returns =
  (value: DecideReply | null): DecideImpl =>
  async () =>
    value;

type Select = (
  title: string,
  options: string[],
  opts?: DialogOptions,
) => Promise<string | undefined>;

export interface FakeCtx {
  ctx: PiContext;
  dialogs: { title: string; opts: DialogOptions | undefined }[];
}

export interface CtxOptions {
  hasUI?: boolean;
  signal?: AbortSignal;
  sessionThrows?: boolean;
  /** Session entries; without them `buildContextEntries` throws (guard mode never reads them). */
  entries?: readonly PiSessionEntry[];
}

function entriesOf(extra: CtxOptions): () => readonly PiSessionEntry[] {
  const { entries } = extra;
  return () => {
    if (entries === undefined) throw new Error('no session entries in this test');
    return entries;
  };
}

export function fakeCtx(
  select: Select = async () => 'Allow once',
  extra: CtxOptions = {},
): FakeCtx {
  const dialogs: { title: string; opts: DialogOptions | undefined }[] = [];
  const session = (): string => {
    if (extra.sessionThrows === true) throw new Error('session read');
    return 'sess-1';
  };
  const ctx: PiContext = {
    ui: {
      select: (title, options, opts) => {
        dialogs.push({ title, opts });
        return select(title, options, opts);
      },
      notify: () => undefined,
      setStatus: () => undefined,
    },
    mode: 'tui',
    hasUI: extra.hasUI ?? true,
    cwd: CWD,
    signal: extra.signal,
    sessionManager: {
      getSessionId: session,
      getCwd: () => (extra.sessionThrows === true ? session() : CWD),
      buildContextEntries: entriesOf(extra),
    },
  };
  return { ctx, dialogs };
}

/** A session message entry. */
export function message(role: 'user' | 'assistant', text: string, id = role): PiSessionEntry {
  const content = role === 'user' ? text : [{ type: 'text', text }];
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-11-25T00:00:00.000Z',
    message: { role, content, timestamp: 0 },
  };
}

function config(mode: GateMode = 'guard'): Config {
  return {
    mode,
    url: 'http://127.0.0.1:8765',
    guardTimeoutMs: 1500,
    approveTimeoutMs: 10_000,
    dialogTimeoutMs: 120_000,
  };
}

export function bash(command: string, toolCallId = 'call_1'): ToolCallEvent {
  return { type: 'tool_call', toolCallId, toolName: 'bash', input: { command } };
}

export function toolEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: 'tool_call', toolCallId: 'call_1', toolName, input };
}

export interface Harness {
  gate: ReturnType<typeof createGate>;
  fake: FakeGateway;
  logs: string[];
  decisions: string[];
  clock: { t: number };
}

export function harness(
  fake: FakeGateway,
  { mode, ...overrides }: Partial<GateDeps> & { mode?: GateMode } = {},
): Harness {
  const logs: string[] = [];
  const decisions: string[] = [];
  const clock = { t: 1_000_000 };
  const gate = createGate({
    getConfig: () => config(mode),
    gateway: fake.gateway,
    now: () => clock.t,
    log: (m) => logs.push(m),
    platform: 'linux',
    onDecision: (id) => decisions.push(id),
    safety: { env: {}, home: HOME },
    ...overrides,
  });
  return { gate, fake, logs, decisions, clock };
}
