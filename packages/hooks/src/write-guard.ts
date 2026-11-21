/**
 * Write guard: file writes into places that must not change silently (`.git`, `.ssh`, CI
 * workflows). Covers the Claude Code edit tools, Codex `apply_patch` and shell commands that carry
 * a patch. Pure string work (no symlink resolution) and no `node:` imports.
 */
import { asRecord, commandOf } from '@ziptie-soft/local-decider-core';

import type { GuardHit } from './guard.ts';
import { patchTargets } from './patch.ts';
import { pathParts } from './paths.ts';

const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;
const PATCH_MARKER = '*** Begin Patch';

function targetsOf(tool: string, input: unknown): string[] {
  if (PATH_TOOLS.has(tool)) {
    const fields = asRecord(input);
    return PATH_FIELDS.map((k) => fields?.[k]).filter((v): v is string => typeof v === 'string');
  }
  const command = commandOf({ tool_input: input });
  const isPatch = tool === 'apply_patch' || (tool === 'Bash' && command?.includes(PATCH_MARKER));
  return isPatch === true && command !== undefined
    ? (patchTargets(command, Number.POSITIVE_INFINITY) ?? [])
    : [];
}

function hitOf(parts: readonly string[], target: string): GuardHit | null {
  if (parts.includes('.git')) {
    return { rule: 'write-git', reason: `write to a .git directory: ${target}` };
  }
  if (parts.includes('.ssh')) {
    return { rule: 'write-ssh', reason: `write to an .ssh directory: ${target}` };
  }
  const flow = parts.findIndex((part, i) => part === '.github' && parts[i + 1] === 'workflows');
  return flow === -1
    ? null
    : { rule: 'write-workflow', reason: `write to a CI workflow: ${target}`, ask: true };
}

/** The first protected write the call makes, or null (also for anything it cannot read). */
export function writeGuard(tool: string, input: unknown, cwd: string): GuardHit | null {
  for (const target of targetsOf(tool, input)) {
    const hit = target === '' ? null : hitOf(pathParts(cwd === '' ? '/' : cwd, target), target);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}
