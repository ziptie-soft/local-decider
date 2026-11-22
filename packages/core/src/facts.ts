/**
 * `facts`: a short, deterministic description of a tool call, derived from the already-redacted
 * request input and rendered through fixed templates. Facts describe what a call touches and
 * which commands it runs; they never judge it. Every value echoed from the input is sanitised
 * into a single capped, backticked token, so a path or command cannot forge a line, a section
 * or a verdict. Pure: no I/O, and nothing here reads the filesystem or runs anything.
 */
import { commandFlags, hasSubstitution, segmentParts, wordPath } from './block.ts';
import { guardCommand } from './guard.ts';
import { patchTargets } from './patch.ts';
import { locatePath } from './paths.ts';
import { splitShell, type Segment } from './shell.ts';
import { asRecord, str } from './subject.ts';
import { cutText } from './truncate.ts';

export const FACT_GROUPS = [
  'kind',
  'paths',
  'commands',
  'notes',
  'git-refs',
  'hints',
  'content',
] as const;
export type FactGroup = (typeof FACT_GROUPS)[number];

/** The groups the gateway derives by default; empty until a measured set ships. */
export const SHIPPED_FACTS: readonly FactGroup[] = [];

/** The state section cap for facts. */
export const FACTS_MAX_CHARS = 800;
const TOKEN_CHARS = 80;
const MAX_COMMAND_CHARS = 16 * 1024;
const MAX_SEGMENTS = 64;
const MAX_PATHS = 6;
const MAX_COMMANDS = 8;
const MAX_PATCH_TARGETS = 32;

const PATH_FIELDS = ['file_path', 'filePath', 'notebook_path', 'path'] as const;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`]/gu;

/** An input-derived value as one inert token: no controls, bidi marks or backticks, capped. */
function token(value: string): string {
  const flat = value.replaceAll(UNSAFE_CHARS, (c) => (c === '`' ? '' : ' ')).trim();
  return `\`${cutText(flat, TOKEN_CHARS, 'head')}\``;
}

function more(shown: readonly string[], total: number): string {
  return total > shown.length ? `, +${String(total - shown.length)} more` : '';
}

// --- kind -----------------------------------------------------------------------------------

const KINDS: Readonly<Record<string, string>> = {
  Bash: 'runs a shell command',
  Write: 'writes a whole file',
  Edit: 'replaces text in a file',
  MultiEdit: 'replaces text in a file',
  NotebookEdit: 'edits a notebook cell',
  apply_patch: 'applies a patch',
};

function kindLine(tool: string | undefined, hasCommand: boolean): string | undefined {
  if (tool === undefined) {
    return hasCommand ? 'Kind: runs a shell command' : undefined;
  }
  const known = Object.hasOwn(KINDS, tool) ? KINDS[tool] : undefined;
  if (known !== undefined) {
    return `Kind: ${known}`;
  }
  const mcp = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(tool.slice(0, 200));
  if (mcp !== null) {
    return `Kind: calls MCP tool ${token(mcp[2] ?? '')} on server ${token(mcp[1] ?? '')}`;
  }
  return `Kind: uses tool ${token(tool)}`;
}

// --- shell parsing ----------------------------------------------------------------------------

interface Parsed {
  readonly text: string;
  readonly segments: readonly Segment[];
}

function parseCommand(text: string): Parsed {
  const cut = text.slice(0, MAX_COMMAND_CHARS);
  return { text: cut, segments: splitShell(cut).slice(0, MAX_SEGMENTS) };
}

function commandText(
  record: Readonly<Record<string, unknown>> | undefined,
  raw: unknown,
): string | undefined {
  const value = record === undefined ? raw : record['command'];
  if (Array.isArray(value)) {
    return value.filter((w) => typeof w === 'string').join(' ');
  }
  return str(value);
}

// --- paths ------------------------------------------------------------------------------------

function describePath(path: string, cwd: string | undefined): string | undefined {
  if (path === '' || path === '/dev/null') {
    return undefined;
  }
  if (cwd === undefined) {
    return token(path);
  }
  const place = locatePath(cwd, path);
  const note =
    place.where === 'inside'
      ? 'inside the project'
      : place.where === 'outside'
        ? 'outside the project'
        : 'protected';
  return `${token(place.shown)} (${note})`;
}

function unresolvedNote(word: string): string {
  return word
    .replace(/^\d*>{1,2}/, '')
    .replace(/^--?[\w-]+=/, '')
    .startsWith('~')
    ? 'home directory, unresolved'
    : 'variable, unresolved';
}

function fieldPaths(record: Readonly<Record<string, unknown>> | undefined): string[] {
  return PATH_FIELDS.flatMap((k) => {
    const v = str(record?.[k]);
    return v === undefined ? [] : [v];
  });
}

function shellPaths(segments: readonly Segment[], cwd: string | undefined): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    for (const word of segmentParts(segment).args) {
      // A URL is not a path, and `https://x` would otherwise read as a project file.
      const path = word.includes('://') ? undefined : wordPath(word);
      if (path === null) {
        out.push(`${token(word)} (${unresolvedNote(word)})`);
      } else if (path !== undefined) {
        const described = describePath(path, cwd);
        if (described !== undefined) {
          out.push(described);
        }
      }
    }
  }
  return out;
}

function patchPaths(text: string | undefined): string[] {
  const targets = text === undefined ? [] : (patchTargets(text, MAX_PATCH_TARGETS) ?? []);
  return targets;
}

function pathsLine(
  record: Readonly<Record<string, unknown>> | undefined,
  parsed: Parsed | undefined,
  patch: string | undefined,
  cwd: string | undefined,
): string | undefined {
  const described = [
    ...fieldPaths(record).map((p) => describePath(p, cwd)),
    ...patchPaths(patch).map((p) => describePath(p, cwd)),
    ...(parsed === undefined ? [] : shellPaths(parsed.segments, cwd)),
  ].filter((p): p is string => p !== undefined);
  const unique = [...new Set(described)];
  if (unique.length === 0) {
    return undefined;
  }
  const shown = unique.slice(0, MAX_PATHS);
  return `Paths: ${shown.join(', ')}${more(shown, unique.length)}`;
}

// --- commands ---------------------------------------------------------------------------------

const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'mise', 'cargo', 'go', 'make']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function subcommand(command: string, args: readonly string[]): string | undefined {
  if (!SUBCOMMAND_TOOLS.has(command)) {
    return undefined;
  }
  let skip = false;
  for (const arg of args) {
    if (skip) {
      skip = false;
    } else if (command === 'git' && GIT_VALUE_FLAGS.has(arg)) {
      skip = true;
    } else if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
}

function commandNames(segments: readonly Segment[]): string[] {
  const names = segments.flatMap((segment) => {
    const { command, args } = segmentParts(segment);
    if (command === '') {
      return [];
    }
    const sub = subcommand(command, args);
    return [token(sub === undefined ? command : `${command} ${sub}`)];
  });
  return [...new Set(names)];
}

function commandsLine(segments: readonly Segment[]): string | undefined {
  const names = commandNames(segments);
  if (names.length === 0) {
    return undefined;
  }
  const shown = names.slice(0, MAX_COMMANDS);
  return `Commands: ${shown.join(', ')}${more(shown, names.length)}`;
}

// --- notes ------------------------------------------------------------------------------------

const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'netcat', 'gh']);
const CONTAINERS = new Set(['docker', 'podman', 'kubectl']);

function segmentNotes(segment: Segment): string[] {
  const { elevated, command, args } = segmentParts(segment);
  const notes: string[] = [];
  if (elevated !== undefined) {
    notes.push('runs with elevated privileges');
  }
  if (NETWORK.has(command)) {
    notes.push(`reaches the network or another host via ${token(command)}`);
  }
  if (CONTAINERS.has(command)) {
    notes.push(`manages containers or clusters via ${token(command)}`);
  }
  if (command === 'eval') {
    notes.push('evaluates a string as shell code');
  }
  const kinds: Readonly<Record<string, string>> = {
    'push': 'pushes to a remote',
    'publish': 'publishes a package',
    'rm-r': 'deletes recursively',
    'shell-c': 'runs an inline shell script',
  };
  for (const flag of commandFlags(command, args)) {
    const note = kinds[flag.kind];
    if (note !== undefined) {
      notes.push(note);
    }
  }
  return notes;
}

function notesFor(parsed: Parsed): string[] {
  const notes = parsed.segments.flatMap(segmentNotes);
  if (hasSubstitution(parsed.text)) {
    notes.push('uses command substitution');
  }
  const guard = guardCommand(parsed.text);
  if (guard !== null) {
    notes.push(`matches a guard rule: ${token(guard.reason)}`);
  }
  return notes;
}

// --- git refs ---------------------------------------------------------------------------------

function gitRefLabel(args: readonly string[]): string | undefined {
  const sub = subcommand('git', args);
  if (sub === undefined) {
    return undefined;
  }
  const rest = args.slice(args.indexOf(sub) + 1);
  const has = (...flags: string[]): boolean => rest.some((a) => flags.includes(a));
  const rules: [boolean, string][] = [
    [sub === 'reset' && has('--hard'), 'reset --hard'],
    [
      sub === 'branch' && has('-d', '-D', '-m', '-M', '--delete', '--move'),
      'branch delete or rename',
    ],
    [sub === 'update-ref' && has('-d'), 'update-ref -d'],
    [sub === 'filter-branch', 'filter-branch'],
    [sub === 'rebase', 'rebase'],
    [sub === 'push' && has('--delete', '-d'), 'push --delete'],
    [sub === 'tag' && has('-d', '--delete'), 'tag -d'],
    [sub === 'checkout' && rest.includes('--') && rest.includes('.'), 'checkout -- .'],
  ];
  return rules.find(([hit]) => hit)?.[1];
}

function gitRefNotes(segments: readonly Segment[]): string[] {
  return segments.flatMap((segment) => {
    const { command, args } = segmentParts(segment);
    const label = command === 'git' ? gitRefLabel(args) : undefined;
    return label === undefined ? [] : [`rewrites or deletes git history or refs (${label})`];
  });
}

// --- hints ------------------------------------------------------------------------------------

const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl']);
const RUNNERS = new Set(['mise', 'npm', 'pnpm', 'yarn']);

function lineCount(text: string): number {
  return text.split('\n').length;
}

function segmentHints(segment: Segment): string[] {
  const { command, args } = segmentParts(segment);
  const hints: string[] = [];
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) && !a.startsWith('--'));
  if ((command === 'sed' || command === 'perl') && inPlace) {
    hints.push(`edits files in place (${command} -i)`);
  }
  if (INTERPRETERS.has(command) && segment.heredoc !== '') {
    hints.push(
      `runs an inline ${command} script (heredoc, ${String(lineCount(segment.heredoc))} lines)`,
    );
  }
  const sub = subcommand(command, args);
  const task = args[args.indexOf('run') + 1];
  if (RUNNERS.has(command) && sub === 'run' && task !== undefined) {
    hints.push(`runs task ${token(task)} (${command} run)`);
  } else if (command === 'make' && sub !== undefined) {
    hints.push(`runs task ${token(sub)} (make)`);
  }
  return hints;
}

// --- content ----------------------------------------------------------------------------------

function contentLine(record: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const texts: string[] = [];
  for (const key of ['content', 'new_string'] as const) {
    const v = record?.[key];
    if (typeof v === 'string') {
      texts.push(v);
    }
  }
  const edits = record?.['edits'];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const v = asRecord(edit)?.['new_string'];
      if (typeof v === 'string') {
        texts.push(v);
      }
    }
  }
  if (texts.length === 0) {
    return undefined;
  }
  const lines = texts.reduce((n, t) => n + lineCount(t), 0);
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return `Content: ${String(lines)} lines, ${String(chars)} chars`;
}

// --- assembly ---------------------------------------------------------------------------------

function joinNotes(label: string, items: readonly string[]): string | undefined {
  const unique = [...new Set(items)];
  return unique.length === 0 ? undefined : `${label}: ${unique.join('; ')}`;
}

function capLines(lines: readonly string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    size += line.length + (kept.length > 0 ? 1 : 0);
    if (size > FACTS_MAX_CHARS) {
      break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Facts for one call, `''` when nothing applies. `request` is the tool's input object (or the
 * bare command string); everything echoed from it is sanitised and capped, and the text never
 * exceeds {@link FACTS_MAX_CHARS}.
 */
export function callFacts(
  tool: string | undefined,
  request: unknown,
  cwd: string | undefined,
  groups: ReadonlySet<FactGroup>,
): string {
  if (groups.size === 0) {
    return '';
  }
  const record = asRecord(request);
  const patching = tool === 'apply_patch';
  const text = commandText(record, request);
  const parsed = text === undefined || patching ? undefined : parseCommand(text);
  const segments = parsed?.segments ?? [];
  const lines: (string | undefined)[] = [
    groups.has('kind') ? kindLine(tool, parsed !== undefined) : undefined,
    groups.has('paths') ? pathsLine(record, parsed, patching ? text : undefined, cwd) : undefined,
    groups.has('commands') ? commandsLine(segments) : undefined,
    joinNotes('Notes', [
      ...(groups.has('notes') && parsed !== undefined ? notesFor(parsed) : []),
      ...(groups.has('git-refs') ? gitRefNotes(segments) : []),
    ]),
    groups.has('hints') ? joinNotes('Hints', segments.flatMap(segmentHints)) : undefined,
    groups.has('content') ? contentLine(record) : undefined,
  ];
  return capLines(lines.filter((l): l is string => l !== undefined));
}
