/**
 * The `permission` policy's input, built the same way for every client (the hook runner, the Claude
 * Code mod and the Paseo plugin). No `node:` imports: the Paseo plugin vendors this file with
 * `input-cap.ts`, `truncate.ts` and `canonical.ts`.
 */
import { capInput } from './input-cap.ts';

/** `name (cwd)`: how the policies refer to the project. */
export function projectLabel(cwd: string): string {
  // A loop, not `/\/+$/`, which backtracks quadratically on long runs of slashes.
  let end = cwd.length;
  while (end > 0 && cwd.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  const name = cwd.slice(0, end).split('/').at(-1) ?? '';
  return `${name === '' ? cwd : name} (${cwd})`;
}

export interface PermissionInputParts {
  readonly cwd?: string | undefined;
  readonly tool?: string | undefined;
  readonly request: unknown;
  readonly subject?: string | undefined;
  /** Recent conversation and the task text, already rendered by the client. */
  readonly history?: string | undefined;
  readonly task?: string | undefined;
}

/** Keys the policy's `state.sections` read, capped per key; empty values are left out. */
export function buildPermissionInput(parts: PermissionInputParts): Record<string, unknown> {
  const input: Record<string, unknown> = {
    project: parts.cwd === undefined ? undefined : projectLabel(parts.cwd),
    history: parts.history,
    task: parts.task,
    tool: parts.tool,
    request: parts.request,
    subject: parts.subject,
  };
  return capInput(
    Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')),
  );
}
