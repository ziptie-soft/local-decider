/**
 * Subagent results as the `turn-outcome` policy wants them. Claude Code reports a finished
 * `Agent`/`Task` tool call in a `PostToolUse` event: the prompt the parent gave is
 * `tool_input.prompt`, the subagent's report is `tool_response.content`. All of it is untrusted
 * agent text; nothing here reads the transcript or executes anything.
 */
import { str, type HookInput } from '@ziptie-soft/local-decider-core';

const AGENT_TOOLS: readonly string[] = ['Agent', 'Task'];
const LABEL = /^[\w:.-]{1,64}$/;
const FALLBACK_LABEL = 'subagent';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A foreground `Agent`/`Task` call that finished (`status: completed`); not a background launch. */
export function isCompletedAgent(hook: HookInput): boolean {
  const tool = str(hook['tool_name']);
  return (
    tool !== undefined &&
    AGENT_TOOLS.includes(tool) &&
    record(hook['tool_response'])?.['status'] === 'completed'
  );
}

/** The text blocks of the subagent's report, joined; empty when it has none. */
function reportText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block: unknown) => {
      const part = record(block);
      return part?.['type'] === 'text' ? (str(part['text']) ?? '') : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** `task` (the parent's prompt) and `lastMessage` (the subagent's report) for `turn-outcome`. */
export function subagentInput(hook: HookInput): Record<string, unknown> {
  return {
    task: str(record(hook['tool_input'])?.['prompt']),
    lastMessage: reportText(record(hook['tool_response'])?.['content']),
  };
}

/** The subagent type for model-facing text, or `subagent` when it is not a plain identifier. */
export function agentLabel(hook: HookInput): string {
  const type = str(record(hook['tool_input'])?.['subagent_type']);
  return type !== undefined && LABEL.test(type) ? type : FALLBACK_LABEL;
}
