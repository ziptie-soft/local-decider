/**
 * Event → policy mapping. Each hook event becomes one gateway policy call whose input keys match
 * the policy's `state.sections[].from` (see policies/*.yaml).
 */
import {
  CALL_ID,
  commandOf,
  canonicalSubject,
  capInput,
  PERMISSION_MODES,
  str,
  type DecideCall,
  type HookInput,
  type PermissionMode,
} from '@ziptie-soft/local-decider-core';

import { permissionInput, projectLabel } from './permission-input.ts';
import { subagentInput } from './subagent.ts';
import { parseTurns, type TranscriptSlice } from './transcript.ts';
import { firstUserText, historyText, lastAssistantText, lastUserText, type Turn } from './turns.ts';

const HOOK_HARNESSES = ['claude', 'codex'] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

const POLICY_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'Stop',
  'UserPromptSubmit',
  'SubagentResult',
] as const;
/**
 * Hook events that run a gateway policy. `SubagentResult` is argv-only: Claude Code sends it as a
 * `PostToolUse` event on the `Agent`/`Task` tools, and hooks.json routes that group here.
 */
export type PolicyEvent = (typeof POLICY_EVENTS)[number];

const LIFECYCLE_EVENTS = ['SessionStart', 'PostToolUse'] as const;
/** Hook events handled by the runner itself, without a policy. */
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export type HookEvent = PolicyEvent | LifecycleEvent;
const HOOK_EVENTS: readonly HookEvent[] = [...POLICY_EVENTS, ...LIFECYCLE_EVENTS];

export function isLifecycleEvent(event: HookEvent): event is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly HookEvent[]).includes(event);
}

/** The gateway policy each policy event runs. */
export const EVENT_POLICY: Readonly<Record<PolicyEvent, string>> = {
  PreToolUse: 'command-risk',
  PermissionRequest: 'permission',
  Stop: 'turn-outcome',
  UserPromptSubmit: 'routing',
  SubagentResult: 'turn-outcome',
};

export interface PolicyCall {
  readonly policy: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly hasRecentUserContext?: boolean;
  readonly workspace?: { readonly cwd: string };
}

export type ReadTranscript = (path: string) => TranscriptSlice | null;

/** Accept `PreToolUse` and `pre-tool-use` spellings. */
export function parseEvent(name: string): HookEvent | undefined {
  const pascal = name.replace(/(?:^|[-_])([a-z])/g, (_m, c: string) => c.toUpperCase());
  return HOOK_EVENTS.find((e) => e === pascal);
}

export function parseHarness(name: string): HookHarness | undefined {
  return HOOK_HARNESSES.find((h) => h === name);
}

function projectOf(hook: HookInput): string | undefined {
  const cwd = str(hook['cwd']);
  return cwd === undefined ? undefined : projectLabel(cwd);
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
}

class Transcript {
  readonly #path: string | undefined;
  readonly #read: ReadTranscript;
  #slice: TranscriptSlice | null | undefined;

  constructor(path: string | undefined, read: ReadTranscript) {
    this.#path = path;
    this.#read = read;
  }

  #get(): TranscriptSlice | null {
    if (this.#slice === undefined) {
      this.#slice = this.#path === undefined ? null : this.#read(this.#path);
    }
    return this.#slice;
  }

  tail(): Turn[] {
    return parseTurns(this.#get()?.tail ?? '');
  }

  head(): Turn[] {
    return parseTurns(this.#get()?.head ?? '');
  }

  hasRecentUser(): boolean {
    return lastUserText(this.tail()) !== undefined;
  }
}

function permissionHookInput(hook: HookInput, t: Transcript): Record<string, unknown> {
  const tool = str(hook['tool_name']);
  return permissionInput({
    cwd: str(hook['cwd']),
    tool,
    request: hook['tool_input'],
    subject:
      tool === undefined ? undefined : canonicalSubject(tool, hook['tool_input'], str(hook['cwd'])),
    head: t.head(),
    tail: t.tail(),
  });
}

function workspaceOf(hook: HookInput): { readonly cwd: string } | undefined {
  const cwd = str(hook['cwd']);
  return cwd === undefined ? undefined : { cwd };
}

function commandRiskInput(hook: HookInput): Record<string, unknown> {
  return {
    project: projectOf(hook),
    tool: str(hook['tool_name']),
    command: commandOf(hook) ?? hook['tool_input'],
  };
}

function turnOutcomeInput(hook: HookInput, t: Transcript): Record<string, unknown> {
  const tail = t.tail();
  return {
    task: firstUserText(t.head()),
    history: historyText(tail),
    lastMessage: str(hook['last_assistant_message']) ?? lastAssistantText(tail),
  };
}

function routingInput(hook: HookInput): Record<string, unknown> {
  return { project: projectOf(hook), prompt: str(hook['prompt']) };
}

type InputBuilder = (hook: HookInput, t: Transcript) => Record<string, unknown>;

const BUILDERS: Record<PolicyEvent, InputBuilder> = {
  PreToolUse: (hook) => commandRiskInput(hook),
  PermissionRequest: permissionHookInput,
  Stop: turnOutcomeInput,
  UserPromptSubmit: (hook) => routingInput(hook),
  SubagentResult: (hook) => subagentInput(hook),
};

/**
 * The Claude Code tool call an event is about, so the gateway can serve it to other callers: for
 * PreToolUse the `tool_use_id` and `permission_mode`; for SubagentResult the `tool_use_id`, marked
 * as a subagent call. Absent or malformed values are left out.
 */
export function callOf(
  harness: HookHarness,
  event: HookEvent,
  hook: HookInput,
): DecideCall | undefined {
  const id = str(hook['tool_use_id']);
  const known = event === 'PreToolUse' || event === 'SubagentResult';
  if (harness !== 'claude' || !known || id === undefined || !CALL_ID.test(id)) {
    return undefined;
  }
  if (event === 'SubagentResult') {
    return { id, agent: true };
  }
  const mode = hook['permission_mode'];
  const permissionMode = (PERMISSION_MODES as readonly unknown[]).includes(mode)
    ? (mode as PermissionMode)
    : undefined;
  return { id, ...(permissionMode === undefined ? {} : { permissionMode }) };
}

/** Build the gateway call for an event. Transcript reads happen only for policies that use them. */
export function mapEvent(event: PolicyEvent, hook: HookInput, read: ReadTranscript): PolicyCall {
  const transcript = new Transcript(str(hook['transcript_path']), read);
  const input = BUILDERS[event](hook, transcript);
  const workspace =
    event === 'PermissionRequest' || event === 'PreToolUse' ? workspaceOf(hook) : undefined;
  return {
    policy: EVENT_POLICY[event],
    input: compact(capInput(input)),
    ...(event === 'PermissionRequest' ? { hasRecentUserContext: transcript.hasRecentUser() } : {}),
    ...(workspace === undefined ? {} : { workspace }),
  };
}
