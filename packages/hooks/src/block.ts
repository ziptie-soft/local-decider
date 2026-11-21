/**
 * Deterministic call checks: why the local decider must not be asked to allow a call. Pure, no
 * I/O, no `node:` imports (the Claude Code mod bundles it).
 */
import { asRecord, commandOf } from '@ziptie-soft/local-decider-core';

import { patchTargets } from './patch.ts';
import { pathBlock } from './paths.ts';
import { baseName, commandWords, splitShell, type Segment } from './shell.ts';

/** Path-bearing tools and the input fields that name the path. */
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

function filePathBlock(input: unknown, cwd: string): string | null {
  const fields = asRecord(input);
  const paths = PATH_FIELDS.map((k) => fields?.[k]).filter((v) => v !== undefined);
  if (paths.length === 0) {
    return 'no file path';
  }
  for (const path of paths) {
    const block = typeof path === 'string' ? pathBlock(cwd, path) : 'unreadable file path';
    if (block !== null) {
      return block;
    }
  }
  return null;
}

/** Commands that reach the network, other machines, containers, or hosted services. */
const BLOCKED_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'sudo',
  'doas',
  'docker',
  'podman',
  'kubectl',
  'gh',
  'eval',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Constructs the splitter cannot see through: substitutions, process substitution. */
const OPAQUE = /\$\(|`|<\(|>\(/;
const RECURSIVE_FLAG = /^-[a-zA-Z]*[rR]/;

function commandBlock(command: string, args: readonly string[]): string | null {
  if (BLOCKED_COMMANDS.has(command)) {
    return `${command} is never allowed here`;
  }
  const flags = args.filter((a) => a.startsWith('-'));
  const reasons: [boolean, string][] = [
    [command === 'git' && args.includes('push'), 'git push'],
    [PUBLISHERS.has(command) && args.includes('publish'), `${command} publish`],
    [command === 'rm' && flags.some((f) => RECURSIVE_FLAG.test(f) || f === '--recursive'), 'rm -r'],
    [SHELLS.has(command) && flags.some((f) => /^-[a-zA-Z]*c/.test(f)), `${command} -c script`],
  ];
  return reasons.find(([hit]) => hit)?.[1] ?? null;
}

/** The path a word names, with `>file`, `--out=/x` and `-C/x` shapes unwrapped; null when it names none. */
function wordPath(word: string): string | null | undefined {
  const bare = word.replace(/^\d*>{1,2}/, '').replace(/^--?[\w-]+=/, '');
  if (bare === '' || bare.startsWith('-')) {
    return undefined;
  }
  if (/^[~$]/.test(bare)) {
    return null;
  }
  return bare.startsWith('/') || bare.startsWith('.') || bare.includes('/') ? bare : undefined;
}

function wordsBlock(words: readonly string[], cwd: string): string | null {
  for (const word of words) {
    const path = wordPath(word);
    if (path === null) {
      return `unresolved path: ${word}`;
    }
    const block = path === undefined ? null : pathBlock(cwd, path);
    if (block !== null) {
      return block;
    }
  }
  return null;
}

function segmentBlock(segment: Segment, cwd: string): string | null {
  const words = commandWords(segment.words);
  // `sudo`/`doas` are stripped as prefixes to find the real command; they still block.
  const prefixes = segment.words.slice(0, segment.words.length - words.length).map(baseName);
  const elevated = prefixes.find((p) => p === 'sudo' || p === 'doas');
  const command = baseName(words[0] ?? '');
  const args = words.slice(1);
  return (
    (elevated === undefined ? null : `${elevated} is never allowed here`) ??
    commandBlock(command, args) ??
    wordsBlock(args, cwd)
  );
}

function bashBlock(input: unknown, cwd: string): string | null {
  const command = commandOf({ tool_input: input });
  if (command === undefined || command.trim() === '') {
    return 'no command';
  }
  if (OPAQUE.test(command)) {
    return 'command substitution';
  }
  for (const segment of splitShell(command)) {
    const block = segmentBlock(segment, cwd);
    if (block !== null) {
      return block;
    }
  }
  return null;
}

/** Codex `apply_patch`: the patch text is the call's `command`; every target is checked. */
function patchBlock(input: unknown, cwd: string): string | null {
  const text = asRecord(input)?.['command'];
  if (typeof text !== 'string') {
    return 'no command';
  }
  const targets = patchTargets(text);
  if (targets === null) {
    return 'too many patch targets';
  }
  if (targets.length === 0) {
    return 'no file path';
  }
  for (const target of targets) {
    const block = pathBlock(cwd, target);
    if (block !== null) {
      return block;
    }
  }
  return null;
}

/**
 * Why the local decider must not be asked to allow this call (the classifier decides instead), or
 * null. Claude Code's own path-safety asks carry no field the mod can read, so this is where
 * paths outside the working directory and in protected places are kept away from an allow.
 */
export function deterministicBlock(tool: string, input: unknown, cwd: string): string | null {
  if (tool === 'Bash') {
    return bashBlock(input, cwd);
  }
  if (tool === 'apply_patch') {
    return patchBlock(input, cwd);
  }
  return PATH_TOOLS.has(tool) ? filePathBlock(input, cwd) : `tool ${tool} is not covered`;
}
