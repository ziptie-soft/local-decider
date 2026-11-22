/**
 * The `permission` policy's input for the hook runner (transcript file) and the Claude Code mod
 * (`$.session.messages()`): the conversation turns are rendered here, the keys are assembled by the
 * shared core builder. No `node:` imports.
 */
import { buildPermissionInput, projectLabel } from '@ziptie-soft/local-decider-core';

import { firstUserText, historyText, lastUserText, taskText, type Turn } from './turns.ts';

export { projectLabel };

export interface PermissionParts {
  readonly cwd?: string | undefined;
  readonly tool?: string | undefined;
  readonly request: unknown;
  readonly subject?: string | undefined;
  /** The start of the conversation (for the first request) and its recent end (history, latest). */
  readonly head: readonly Turn[];
  readonly tail: readonly Turn[];
}

/** Keys the policy's `state.sections` read; empty values are left out. */
export function permissionInput(parts: PermissionParts): Record<string, unknown> {
  return buildPermissionInput({
    cwd: parts.cwd,
    tool: parts.tool,
    request: parts.request,
    subject: parts.subject,
    history: historyText(parts.tail),
    task: taskText(firstUserText(parts.head), lastUserText(parts.tail)),
  });
}
