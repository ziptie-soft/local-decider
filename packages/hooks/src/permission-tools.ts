/**
 * The tools a `PermissionRequest` may be auto-allowed for. Anything else abstains (the hook emits
 * nothing), so the harness shows its normal prompt: plan approval (`ExitPlanMode`), questions to
 * the user (`AskUserQuestion`), subagents (`Task`/`Agent`), unknown tools and every `mcp__*` tool.
 *
 * MCP tools stay excluded until there is a per-tool read-only marker: a name prefix says nothing
 * about what a server's tool does. No read-only built-in (Read, Glob, Grep, ...) is listed because
 * the permission policy does not map them today.
 *
 * Keep `hooks.json` / `codex-hooks.json` PermissionRequest matchers in step with these lists.
 * No `node:` imports: the Claude Code mod bundles this file.
 */
import type { HookHarness } from './mapping.ts';

const CLAUDE_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);
const CODEX_TOOLS: ReadonlySet<string> = new Set(['Bash', 'apply_patch']);

/** Exported for tests and for the matcher consistency check. */
export const PERMISSION_ALLOW_TOOLS: Readonly<Record<HookHarness, ReadonlySet<string>>> = {
  claude: CLAUDE_TOOLS,
  codex: CODEX_TOOLS,
};

/** True when a `PermissionRequest` for `tool` may be auto-allowed. A missing name is not. */
export function mayAutoAllow(harness: HookHarness, tool: string | undefined): boolean {
  return tool !== undefined && PERMISSION_ALLOW_TOOLS[harness].has(tool);
}
