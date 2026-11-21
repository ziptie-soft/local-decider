/**
 * Write guard: file writes into places that must not change silently (`.git`, `.ssh`, CI
 * workflows). Covers the Claude Code edit tools, Codex `apply_patch`, shell commands that carry
 * a patch, and shell redirects (`>`, `>>`, `>|`, `&>`, `N>`) and `tee` operands. The redirect
 * scan reads the splitter's words, so a quoted `">"` word counts as a redirect (a known false
 * positive that only matters when its next word is a protected path). Pure string work (no
 * symlink resolution) and no `node:` imports.
 */
import {
  asRecord,
  baseName,
  commandOf,
  commandWords,
  isShellTool,
  patchTargets,
  pathParts,
  splitShell,
  type GuardHit,
  type Segment,
} from '@ziptie-soft/local-decider-core';

const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;
const PATCH_MARKER = '*** Begin Patch';

/** Targets of every `>` in one word (`>f`, `>>f`, `2>f`, `hi>f`); a bare `>` takes `next`. */
function wordRedirects(word: string, next: string | undefined, out: string[]): void {
  let pos = word.indexOf('>');
  while (pos !== -1) {
    let from = pos + 1;
    if (word[from] === '>' || word[from] === '|') {
      from++;
    }
    const stop = word.indexOf('>', from);
    const attached = word.slice(from, stop === -1 ? word.length : stop);
    const target = attached === '' && stop === -1 ? next : attached;
    if (target !== undefined && target !== '') {
      out.push(target);
    }
    pos = stop;
  }
}

/** `>|` splits at the `|`: the target is then the first word of the next, piped segment. */
function segmentTargets(segment: Segment, following: Segment | undefined, out: string[]): void {
  const { words } = segment;
  const clobber = following?.piped === true ? following.words[0] : undefined;
  for (const [i, word] of words.entries()) {
    wordRedirects(word, i + 1 < words.length ? words[i + 1] : clobber, out);
  }
  const [first = '', ...args] = commandWords(words);
  if (baseName(first) === 'tee') {
    out.push(...args.filter((a) => !a.startsWith('-')));
  }
}

function shellTargets(command: string): string[] {
  const out: string[] = [];
  const segments = splitShell(command);
  for (const [i, segment] of segments.entries()) {
    segmentTargets(segment, segments[i + 1], out);
  }
  if (command.includes(PATCH_MARKER)) {
    out.push(...(patchTargets(command, Number.POSITIVE_INFINITY) ?? []));
  }
  return out;
}

function targetsOf(tool: string, input: unknown): string[] {
  if (PATH_TOOLS.has(tool)) {
    const fields = asRecord(input);
    return PATH_FIELDS.map((k) => fields?.[k]).filter((v): v is string => typeof v === 'string');
  }
  const command = commandOf({ tool_input: input });
  if (command === undefined) {
    return [];
  }
  if (tool === 'apply_patch') {
    return patchTargets(command, Number.POSITIVE_INFINITY) ?? [];
  }
  return isShellTool({ tool_name: tool }) ? shellTargets(command) : [];
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
