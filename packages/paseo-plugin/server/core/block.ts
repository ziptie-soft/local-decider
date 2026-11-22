/**
 * Deterministic call checks: why the local decider must not be asked to allow a call. Pure, no
 * I/O, no `node:` imports (the Claude Code mod bundles it).
 */
import { guardCommand } from './guard.ts';
import { patchTargets } from './patch.ts';
import { pathBlock } from './paths.ts';
import { baseName, commandWords, splitShell, type Segment } from './shell.ts';
import { asRecord, commandOf } from './subject.ts';

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

export type CommandFlagKind = 'blocked' | 'push' | 'publish' | 'rm-r' | 'shell-c';

export interface CommandFlag {
  readonly kind: CommandFlagKind;
  /** The reason the guard gives for it, e.g. `git push` or `curl is never allowed here`. */
  readonly reason: string;
}

/** Every reason a command word and its arguments are kept away from an allow, in rule order. */
export function commandFlags(command: string, args: readonly string[]): CommandFlag[] {
  const flags = args.filter((a) => a.startsWith('-'));
  const candidates: [boolean, CommandFlag][] = [
    [
      BLOCKED_COMMANDS.has(command),
      { kind: 'blocked', reason: `${command} is never allowed here` },
    ],
    [command === 'git' && args.includes('push'), { kind: 'push', reason: 'git push' }],
    [
      PUBLISHERS.has(command) && args.includes('publish'),
      { kind: 'publish', reason: `${command} publish` },
    ],
    [
      command === 'rm' && flags.some((f) => RECURSIVE_FLAG.test(f) || f === '--recursive'),
      { kind: 'rm-r', reason: 'rm -r' },
    ],
    [
      SHELLS.has(command) && flags.some((f) => /^-[a-zA-Z]*c/.test(f)),
      { kind: 'shell-c', reason: `${command} -c script` },
    ],
  ];
  return candidates.filter(([hit]) => hit).map(([, flag]) => flag);
}

/** True for the constructs the splitter cannot see through: substitutions, process substitution. */
export function hasSubstitution(command: string): boolean {
  return OPAQUE.test(command);
}

function commandBlock(command: string, args: readonly string[]): string | null {
  if (BLOCKED_COMMANDS.has(command)) {
    return `${command} is never allowed here`;
  }
  return commandFlags(command, args)[0]?.reason ?? null;
}

/** The path a word names, with `>file`, `--out=/x` and `-C/x` shapes unwrapped; null when it names none. */
export function wordPath(word: string): string | null | undefined {
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

export interface SegmentParts {
  /** `sudo` or `doas` when stripped as a prefix to find the real command. */
  readonly elevated: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
}

/** A segment's real command (base name), its arguments and any `sudo`/`doas` prefix. */
export function segmentParts(segment: Segment): SegmentParts {
  const words = commandWords(segment.words);
  // `sudo`/`doas` are stripped as prefixes to find the real command; they still block.
  const prefixes = segment.words.slice(0, segment.words.length - words.length).map(baseName);
  return {
    elevated: prefixes.find((p) => p === 'sudo' || p === 'doas'),
    command: baseName(words[0] ?? ''),
    args: words.slice(1),
  };
}

function segmentBlock(segment: Segment, cwd: string): string | null {
  const { elevated, command, args } = segmentParts(segment);
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
  const hit = guardCommand(command);
  if (hit !== null) {
    return hit.reason;
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
  if (tool === 'Bash' || tool === 'shell' || tool === 'exec_command') {
    return bashBlock(input, cwd);
  }
  if (tool === 'apply_patch') {
    return patchBlock(input, cwd);
  }
  return PATH_TOOLS.has(tool) ? filePathBlock(input, cwd) : `tool ${tool} is not covered`;
}
