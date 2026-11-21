import {
  baseName,
  commandWords,
  parseShell,
  substitutions,
  type Segment,
  type ShellParse,
} from './shell.ts';
/**
 * Deterministic guard: a short, conservative list of shell commands that are destructive enough
 * to deny without asking a model. It runs before any gateway call and never allows anything; a
 * miss simply falls through to the `command-risk` policy.
 */
import { resolveSegments } from './subject.ts';

export interface GuardHit {
  readonly rule: string;
  readonly reason: string;
  /** The harness should ask rather than deny (Codex cannot ask: it denies). */
  readonly ask?: true;
}

const SYSTEM_DIRS = [
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'lib32',
  'lib64',
  'opt',
  'proc',
  'root',
  'sbin',
  'srv',
  'sys',
  'usr',
  'var',
  'Applications',
  'Library',
  'System',
  'Users',
  'private',
];
/** `/`, `/*`, `~`, `$HOME` and top-level system directories, with an optional `/` or `/*`. */
const DANGEROUS_TARGET = new RegExp(
  `^(?:/|/\\*|(?:~|\\$HOME|\\$\\{HOME\\})(?:/|/\\*)?|/(?:${SYSTEM_DIRS.join('|')})(?:/|/\\*)?)$`,
);
/** A `.git` directory or its contents: `.git`, `./.git/`, `repo/.git`, `.git/*`, any case. */
const GIT_DIR = /(?:^|\/)\.git(?:\/\*?)?$/i;
const DISK = String.raw`/dev/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d)`;
const DISK_DEVICE = new RegExp(`^${DISK}`);
const DISK_REDIRECT = new RegExp(`^\\d?>>?${DISK}`);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
// Linear forms: a shell word, then (in the same `;&|` segment) `<(` or `$(` and a fetcher.
const SHELL_WORD = /\b(?:(?:ba|z|da|k)?sh|eval|source)\b|(?:^|\s)\.(?=\s)/;
const SUBST_FETCH = /(?:<\(|\$\()\s*(?:curl|wget)\b/;
const LEADING_SUBST_FETCH = /^\s*(?:<\(|\$\()\s*(?:curl|wget)\b/;

/** `inScript`: the text is itself a script being run (`eval`, `-c`), so a leading `$(curl …)` runs. */
function hasShellSubstFetch(text: string, inScript: boolean): boolean {
  for (const part of text.split(/[;&|]/)) {
    const m = SHELL_WORD.exec(part);
    if (m !== null && SUBST_FETCH.test(part.slice(m.index + m[0].length))) {
      return true;
    }
    if (inScript && LEADING_SUBST_FETCH.test(part)) {
      return true;
    }
  }
  return false;
}

const NAME_CHAR = /[\w:]/;
const NAME_START = /[A-Za-z_:]/;

/**
 * `name(){name|name&};name` in whitespace-stripped text, the name being any suffix of the word
 * before `(){`. Scans each `(){` once, forwards and backwards over word characters only, so it is
 * linear (a backreference regex is quadratic on a long word).
 */
function hasForkBomb(text: string): boolean {
  for (let i = text.indexOf('(){'); i !== -1; i = text.indexOf('(){', i + 1)) {
    let end = i + 3;
    while (end < text.length && NAME_CHAR.test(text[end] ?? '')) {
      end++;
    }
    const name = text.slice(i + 3, end);
    if (
      name !== '' &&
      NAME_START.test(name[0] ?? '') &&
      i >= name.length &&
      text.startsWith(name, i - name.length) &&
      text.startsWith(`|${name}&};${name}`, end)
    ) {
      return true;
    }
  }
  return false;
}

function flags(args: readonly string[]): readonly string[] {
  return args.filter((a) => a.startsWith('-'));
}

function operands(args: readonly string[]): readonly string[] {
  return args.filter((a) => !a.startsWith('-'));
}

function isRecursive(args: readonly string[]): boolean {
  return flags(args).some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f));
}

/** `path` with `.`, `..` and repeated slashes collapsed (`//`, `/./`, `/usr/..` → `/`). */
function canonical(path: string): string {
  const joined = resolveSegments('', path).join('/');
  return path.startsWith('/') ? `/${joined}` : joined;
}

const isDangerous = (t: string): boolean =>
  DANGEROUS_TARGET.test(t) || (t.startsWith('/') && DANGEROUS_TARGET.test(canonical(t)));
const isGitDir = (t: string): boolean => GIT_DIR.test(t) || GIT_DIR.test(canonical(t));

function checkRm(args: readonly string[]): GuardHit | null {
  if (!isRecursive(args)) {
    return null;
  }
  const targets = operands(args);
  if (targets.some(isDangerous)) {
    return {
      rule: 'rm-root',
      reason: 'recursive delete of the filesystem root, home or a system directory',
    };
  }
  if (targets.some(isGitDir)) {
    return { rule: 'rm-git', reason: 'deletes a .git directory (the repository history)' };
  }
  return null;
}

function checkChmod(args: readonly string[]): GuardHit | null {
  const ops = operands(args);
  const worldWritable = ops.some((o) => /^(?:0?777|(?:a|ugo)\+rwx)$/.test(o));
  if (isRecursive(args) && worldWritable && ops.some(isDangerous)) {
    return {
      rule: 'chmod-777-root',
      reason: 'recursive chmod 777 on the root or a system directory',
    };
  }
  return null;
}

function checkDd(args: readonly string[]): GuardHit | null {
  if (args.some((a) => a.startsWith('of=') && DISK_DEVICE.test(a.slice(3)))) {
    return { rule: 'dd-disk', reason: 'dd writes straight to a disk device' };
  }
  return null;
}

const FORCE = /^(?:--force|--force-with-lease(?:=.*)?)$/;
const SHORT_FLAGS = /^-[A-Za-z]+$/;
/** `-f`, bundled short flags with `f`, `--force`; the includes keeps the match linear. */
const isForce = (a: string): boolean => FORCE.test(a) || (SHORT_FLAGS.test(a) && a.includes('f'));
const PROTECTED_REF = /(?:^|:|\+)(?:refs\/heads\/)?(?:main|master)$/;

const DELETE_REF = /^:(?:refs\/heads\/)?(?:main|master)$/;

function checkGit(args: readonly string[]): GuardHit | null {
  const push = args.indexOf('push');
  if (push === -1) {
    return null;
  }
  const rest = args.slice(push + 1);
  const forced = rest.some(isForce) || rest.some((a) => /^\+./.test(a));
  if (forced && rest.some((a) => PROTECTED_REF.test(a))) {
    return { rule: 'git-force-push-main', reason: 'force-push to main or master' };
  }
  const deleting = rest.includes('--delete') || rest.includes('-d');
  if (
    (deleting && rest.some((a) => PROTECTED_REF.test(a))) ||
    rest.some((a) => DELETE_REF.test(a))
  ) {
    return { rule: 'git-delete-main', reason: 'deletes the main or master branch on the remote' };
  }
  return null;
}

function checkPower(cmd: string, args: readonly string[]): GuardHit | null {
  const systemctl = cmd === 'systemctl' && args.some((a) => POWER.has(a));
  const init = (cmd === 'init' || cmd === 'telinit') && (args[0] === '0' || args[0] === '6');
  if (POWER.has(cmd) || systemctl || init) {
    return { rule: 'shutdown', reason: 'shuts down or reboots the machine' };
  }
  return null;
}

function checkRedirects(words: readonly string[]): GuardHit | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    const next = words[i + 1] ?? '';
    if (DISK_REDIRECT.test(w) || (/^\d?>>?$/.test(w) && DISK_DEVICE.test(next))) {
      return { rule: 'redirect-disk', reason: 'redirects output onto a disk device' };
    }
  }
  return null;
}

/** `-c`, alone or bundled with other short flags (`-lc`, `-ec`). */
const INLINE_FLAG = (a: string): boolean => /^-[A-Za-z]+$/.test(a) && a.includes('c');
const MAX_DEPTH = 4;
/** Shell commands longer than this (MAX_ARG_STRLEN is 128 KiB) are asked about, never scanned. */
export const MAX_COMMAND_CHARS = 1024 * 1024;
export const OVERSIZE_COMMAND: GuardHit = {
  rule: 'oversize-command',
  reason: 'shell command too large to check',
  ask: true,
};
const NESTED: GuardHit = {
  rule: 'nested-shell',
  reason: 'shell commands nested too deeply to check',
  ask: true,
};

/** Check a nested script one level deeper; beyond `MAX_DEPTH` it asks instead. */
function recurse(script: string, depth: number): GuardHit | null {
  return depth >= MAX_DEPTH ? NESTED : guardCommand(script, depth + 1);
}

/** The script of `bash -c "…"`, `bash -lc '…'` (how Codex runs commands), `su -c '…'`, `eval …`. */
function scriptOf(cmd: string, args: readonly string[]): string | undefined {
  if (cmd === 'eval') {
    return args.join(' ');
  }
  if (!SHELLS.has(cmd) && cmd !== 'su') {
    return undefined;
  }
  const long = args.find((a) => a.startsWith('--command='));
  if (long !== undefined) {
    return long.slice('--command='.length);
  }
  const c = args.findIndex(INLINE_FLAG);
  if (c === -1) {
    return undefined;
  }
  return args[c + 1] === '--' ? args[c + 2] : args[c + 1];
}

function checkScript(cmd: string, args: readonly string[], depth: number): GuardHit | null {
  const script = scriptOf(cmd, args);
  return script === undefined ? null : recurse(script, depth);
}

/** The inline part of an `env -S` flag word (`''` for the bare flag), or undefined. */
function splitStringHead(w: string): string | undefined {
  if (w === '-S' || w === '--split-string') {
    return '';
  }
  if (w.startsWith('--split-string=')) {
    return w.slice('--split-string='.length);
  }
  return w.startsWith('-S') ? w.slice(2) : undefined;
}

/** The command string of `env -S '…'` / `env -S… ` / `--split-string=…`, or undefined. */
function envScript(words: readonly string[]): string | undefined {
  const env = words.findIndex((w) => baseName(w) === 'env');
  if (env === -1) {
    return undefined;
  }
  for (let i = env + 1; i < words.length; i++) {
    const w = words[i] ?? '';
    const head = splitStringHead(w);
    if (head !== undefined) {
      return [head, ...words.slice(i + 1)].join(' ');
    }
    if (!w.startsWith('-') && !ASSIGN.test(w)) {
      return undefined;
    }
  }
  return undefined;
}
const ASSIGN = /^[A-Za-z_]\w*=/;

const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Predicates that narrow what `find` selects: a dangerous start with one of them is not a wipe. */
const NARROWING = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '-newer',
  '-mtime',
  '-mmin',
  '-size',
  '-user',
  '-empty',
]);
const FIND_OPTION = /^-(?:[HLP]|O\d)$/;

/** The words after `-exec`/`-ok` at `from` up to the closing `;` or `+`, and where to resume. */
function execWords(args: readonly string[], from: number): { words: string[]; next: number } {
  let end = from;
  while (end < args.length && args[end] !== ';' && args[end] !== '+') {
    end++;
  }
  return { words: args.slice(from, end), next: end + 1 };
}

function checkFindExecs(
  args: readonly string[],
  dangerous: boolean,
  depth: number,
): GuardHit | null {
  for (let i = 0; i < args.length; i++) {
    if (!EXEC_FLAGS.has(args[i] ?? '')) {
      continue;
    }
    const { words, next } = execWords(args, i + 1);
    const hit = depth >= MAX_DEPTH ? NESTED : checkWords(words, depth + 1);
    if (hit !== null) {
      return hit;
    }
    if (dangerous && baseName(commandWords(words)[0] ?? '') === 'rm') {
      return {
        rule: 'rm-root',
        reason: 'find deletes files under the root, home or a system directory',
      };
    }
    i = next - 1;
  }
  return null;
}

function checkFind(args: readonly string[], depth: number): GuardHit | null {
  let k = 0;
  while (FIND_OPTION.test(args[k] ?? '')) {
    k++;
  }
  const stop = args.findIndex((a, i) => i >= k && (a.startsWith('-') || a === '(' || a === '!'));
  const starts = args.slice(k, stop === -1 ? args.length : stop);
  const dangerous = starts.some(isDangerous) && !args.some((a) => NARROWING.has(a));
  if (args.includes('-delete') && dangerous) {
    return { rule: 'rm-root', reason: 'find -delete under the root, home or a system directory' };
  }
  if (args.includes('-delete') && starts.some(isGitDir)) {
    return { rule: 'rm-git', reason: 'find -delete inside a .git directory' };
  }
  return checkFindExecs(args, dangerous, depth);
}

function checkWords(words: readonly string[], depth: number): GuardHit | null {
  const env = envScript(words);
  const viaEnv = env === undefined ? null : recurse(env, depth);
  if (viaEnv !== null) {
    return viaEnv;
  }
  const [first = '', ...args] = commandWords(words);
  const cmd = baseName(first);
  if (cmd === 'rm') {
    return checkRm(args);
  }
  if (cmd.startsWith('mkfs')) {
    return { rule: 'mkfs', reason: 'formats a filesystem' };
  }
  const checks: Record<string, (a: readonly string[], depth: number) => GuardHit | null> = {
    chmod: checkChmod,
    dd: checkDd,
    git: checkGit,
    find: checkFind,
  };
  return (
    checks[cmd]?.(args, depth) ??
    checkPower(cmd, args) ??
    checkScript(cmd, args, depth) ??
    checkRedirects(words)
  );
}

function commandOfSegment(segment: Segment | undefined): { cmd: string; args: readonly string[] } {
  const [first = '', ...args] = commandWords(segment?.words ?? []);
  return { cmd: baseName(first), args };
}

function isFetch(segment: Segment | undefined): boolean {
  const { cmd } = commandOfSegment(segment);
  return cmd === 'curl' || cmd === 'wget';
}

const INTERPRETER = /^(?:python[\d.]*|perl|ruby|node)$/;
const SCRIPT_FLAG = /^-[A-Za-z]*[cemEp]/;

/** A shell, or an interpreter that would read its program from stdin (no script or `-c`/`-e`). */
function readsStdinProgram(segment: Segment | undefined): boolean {
  const { cmd, args } = commandOfSegment(segment);
  if (SHELLS.has(cmd)) {
    return true;
  }
  return (
    INTERPRETER.test(cmd) &&
    operands(args).length === 0 &&
    !flags(args).some((f) => SCRIPT_FLAG.test(f))
  );
}

function isDecode(segment: Segment | undefined): boolean {
  const { cmd, args } = commandOfSegment(segment);
  const decodes = (re: RegExp): boolean => flags(args).some((f) => re.test(f));
  return (
    (cmd === 'base64' && (decodes(/^--decode$/) || decodes(/^-[A-Za-z]*[dD]/))) ||
    (cmd === 'xxd' && decodes(/^-[A-Za-z]*r/))
  );
}

function checkPipeToShell(segments: readonly Segment[]): GuardHit | null {
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg?.piped !== true || !readsStdinProgram(seg)) {
      continue;
    }
    if (isFetch(segments[i - 1])) {
      return { rule: 'curl-pipe-shell', reason: 'pipes a downloaded script into a shell' };
    }
    if (SHELLS.has(commandOfSegment(seg).cmd) && isDecode(segments[i - 1])) {
      return { rule: 'decode-pipe-shell', reason: 'pipes decoded data into a shell' };
    }
  }
  return null;
}

const SUBST_FETCH_HIT: GuardHit = {
  rule: 'curl-pipe-shell',
  reason: 'runs a downloaded script in a shell',
};

function checkRaw(parse: ShellParse, inScript: boolean): GuardHit | null {
  if (hasForkBomb(parse.bare.replace(/\s+/g, ''))) {
    return { rule: 'fork-bomb', reason: 'fork bomb' };
  }
  return hasShellSubstFetch(parse.noSingle, inScript) ? SUBST_FETCH_HIT : null;
}

/** Scripts of `$(…)` / backtick substitutions in `text` (they run, so they are guarded). */
function checkSubstitutions(text: string, depth: number): GuardHit | null {
  const { scripts, tail } = substitutions(text);
  for (const script of scripts) {
    const hit = recurse(script, depth);
    if (hit !== null) {
      return hit;
    }
  }
  // An unterminated `$(` is a syntax error or beyond the scanner: ask, don't rescan the tail.
  return tail === '' ? null : NESTED;
}

/** Unquoted heredoc bodies expand: a fetch or a destructive substitution in one runs. */
function checkExpanded(segment: Segment, depth: number): GuardHit | null {
  if (segment.expanded === '') {
    return null;
  }
  return hasShellSubstFetch(segment.expanded, true)
    ? SUBST_FETCH_HIT
    : checkSubstitutions(segment.expanded, depth);
}

/** A shell that reads its script from stdin (no `-c`). */
function feeds(segment: Segment | undefined): boolean {
  const { cmd, args } = commandOfSegment(segment);
  return SHELLS.has(cmd) && args.findIndex(INLINE_FLAG) === -1;
}

/** A heredoc fed to a shell (`bash <<EOF`, `cat <<EOF | sh`) is a script: check its body. */
function checkHeredoc(segments: readonly Segment[], i: number, depth: number): GuardHit | null {
  const seg = segments[i];
  const next = segments[i + 1];
  if (seg === undefined || seg.heredoc === '') {
    return null;
  }
  return feeds(seg) || (next?.piped === true && feeds(next)) ? recurse(seg.heredoc, depth) : null;
}

/** Return the first deterministic rule a shell command hits, or `null`. */
export function guardCommand(command: string, depth = 0): GuardHit | null {
  const parse = parseShell(command);
  const raw = checkRaw(parse, depth > 0) ?? checkSubstitutions(parse.noSingle, depth);
  if (raw !== null) {
    return raw;
  }
  const { segments } = parse;
  for (const [i, segment] of segments.entries()) {
    const hit =
      checkWords(segment.words, depth) ??
      checkHeredoc(segments, i, depth) ??
      checkExpanded(segment, depth);
    if (hit !== null) {
      return hit;
    }
  }
  return checkPipeToShell(segments);
}
