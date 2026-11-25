/**
 * Gate decisions as gateway requests. The `permission` input comes from the shared builders so it
 * matches the other harnesses; the `command-risk` input has the keys the hooks send.
 */
import { createHash } from 'node:crypto';

import type { SessionContext } from './context.ts';
import { CALL_ID } from './core/ids.ts';
import { capInput } from './core/input-cap.ts';
import { buildPermissionInput, projectLabel } from './core/permission-input.ts';
import { canonicalSubject } from './core/subject.ts';
import type { DecideRequest } from './gateway.ts';
import { mappedInput, type ToolDescriptor } from './tools.ts';

/** The part of `ToolDescriptor` the mapping reads. */
type MappedTool = Pick<ToolDescriptor, 'kind' | 'name' | 'guardTool' | 'command' | 'path'>;

/** The gateway accepts `^[\w-]{1,128}$`; pi's nested codemode ids (`<parent>/<n>`) are hashed. */
export function callId(toolCallId: string): string {
  return CALL_ID.test(toolCallId)
    ? toolCallId
    : `pi-${createHash('sha256').update(toolCallId).digest('hex').slice(0, 40)}`;
}

/** The tool input the shared subject builders read: Claude Code's field names. */
function subjectInput(d: MappedTool, input: unknown): unknown {
  return mappedInput(d) ?? input;
}

/**
 * The tool name the policies see: Claude Code's (`Bash`, `Edit`, `Write`) for pi's built-ins, so the
 * state and the precedent subject read the same in every harness; pi's own name otherwise.
 */
function toolName(d: MappedTool): string {
  return d.guardTool ?? d.name;
}

function envelope(
  sc: SessionContext,
  timeoutMs: number,
  toolCallId: string,
  input: Record<string, unknown>,
): DecideRequest {
  return {
    harness: 'pi',
    sessionId: sc.sessionId,
    input,
    workspace: { cwd: sc.cwd },
    call: { id: callId(toolCallId) },
    budgetMs: Math.max(timeoutMs - 500, 100),
  };
}

export function commandRiskRequest(
  d: MappedTool,
  input: unknown,
  sc: SessionContext,
  timeoutMs: number,
  toolCallId: string,
): DecideRequest {
  return envelope(
    sc,
    timeoutMs,
    toolCallId,
    capInput({
      project: projectLabel(sc.cwd),
      tool: toolName(d),
      command: d.command ?? input,
    }),
  );
}

export function permissionRequest(
  d: MappedTool,
  input: unknown,
  sc: SessionContext,
  timeoutMs: number,
  toolCallId: string,
): DecideRequest {
  const tool = toolName(d);
  return envelope(
    sc,
    timeoutMs,
    toolCallId,
    buildPermissionInput({
      cwd: sc.cwd,
      tool,
      request: input,
      subject: canonicalSubject(tool, subjectInput(d, input), sc.cwd),
      history: sc.history,
      task: sc.task,
    }),
  );
}
