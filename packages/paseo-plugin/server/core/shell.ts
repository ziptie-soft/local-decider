/**
 * A small, quote-aware shell splitter for the deterministic guard. It is not a shell parser: it
 * only needs to find command words and their arguments reliably enough to match a short list of
 * clearly destructive patterns without tripping on quoted text. Every pass is linear in the input.
 */

export interface Segment {
  readonly words: readonly string[];
  /** True when this segment reads the previous one's stdout (`a | b`). */
  readonly piped: boolean;
  /** Bodies of the heredocs this segment's command reads (joined by newlines); `''` when none. */
  readonly heredoc: string;
  /** The bodies among those whose delimiter was unquoted: `$(…)` and backticks in them run. */
  readonly expanded: string;
}

export interface ShellParse {
  readonly segments: readonly Segment[];
  /** The text with every quoted span (and heredoc body) removed. */
  readonly bare: string;
  /** The text with single-quoted (and `$'…'`) spans removed; double quotes stay. */
  readonly noSingle: string;
}

type Quote = '' | "'" | '"' | "$'";

interface Pending {
  readonly delim: string;
  readonly strip: boolean;
  readonly quoted: boolean;
  readonly seg: number;
}

interface SplitState {
  segments: Segment[];
  words: string[];
  word: string;
  inWord: boolean;
  quote: Quote;
  piped: boolean;
  pending: Pending[];
  /** Depth of `((` arithmetic, where `<<` is a shift and not a heredoc. */
  arith: number;
  lineEnd: boolean;
  /** Set once a heredoc has no terminator: later ones are left as commands (no repeated scans). */
  heredocsOff: boolean;
  /** `[start, end)` index pairs of `text` kept in the masked copies (merged when adjacent). */
  bare: number[];
  noSingle: number[];
}

/** Queued heredoc delimiters beyond this are not stripped (bodies stay visible as commands). */
const MAX_HEREDOCS = 8;
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '`']);
const NAME_CHAR = /[\w]/;
type Handler = (s: SplitState, text: string, i: number) => number;

function endWord(s: SplitState): void {
  if (s.inWord) {
    s.words.push(s.word);
  }
  s.word = '';
  s.inWord = false;
}

function endSegment(s: SplitState, next: string, prev: string): void {
  endWord(s);
  if (s.words.length > 0) {
    s.segments.push({ words: s.words, piped: s.piped, heredoc: '', expanded: '' });
  }
  s.words = [];
  // `a | b` pipes; `a || b` does not.
  s.piped = next === '|' && prev !== '|';
}

function addChars(s: SplitState, chars: string): void {
  s.word += chars;
  s.inWord = true;
}

const plain: Handler = (s, text, i) => {
  addChars(s, text[i] ?? '');
  return i;
};

const space: Handler = (s, _text, i) => {
  endWord(s);
  return i;
};

const openQuote: Handler = (s, text, i) => {
  s.quote = text[i] === "'" ? "'" : '"';
  s.inWord = true;
  return i;
};

const separator: Handler = (s, text, i) => {
  const ch = text[i] ?? '';
  endSegment(s, text[i + 1] === '|' ? '' : ch, text[i - 1] ?? '');
  s.lineEnd = ch === '\n';
  return i;
};

/** `((` opens and `))` closes arithmetic, where `<<` is a shift. */
const paren: Handler = (s, text, i) => {
  if (text[i] === '(' && text[i - 1] === '(') {
    s.arith++;
  } else if (text[i] === ')' && text[i - 1] === ')' && s.arith > 0) {
    s.arith--;
  }
  return separator(s, text, i);
};

/** Backslash outside quotes: backslash-newline vanishes, anything else is taken literally. */
const escape: Handler = (s, text, i) => {
  const next = text[i + 1];
  if (next === undefined) {
    addChars(s, '\\');
    return i;
  }
  if (next !== '\n') {
    addChars(s, next);
  }
  return i + 1;
};

/** `$'…'` quoting, `$"…"` (the `$` is dropped), `$IFS` and `${IFS}` (a word break). */
const dollar: Handler = (s, text, i) => {
  const next = text[i + 1];
  if (next === "'") {
    s.quote = "$'";
    s.inWord = true;
    return i + 1;
  }
  if (next === '"') {
    return i;
  }
  if (text.startsWith('${IFS}', i)) {
    endWord(s);
    return i + 5;
  }
  if (text.startsWith('$IFS', i) && !NAME_CHAR.test(text[i + 4] ?? '')) {
    endWord(s);
    return i + 3;
  }
  return plain(s, text, i);
};

/** The delimiter word at `from` (quotes and backslashes stripped) and the index after it. */
function readDelimiter(
  text: string,
  from: number,
): { delim: string; end: number; quoted: boolean } {
  let end = from;
  while (end < text.length) {
    const c = text[end] ?? '';
    if (c === ' ' || c === '\t' || c === '\r' || c === '<' || c === '>' || SEPARATORS.has(c)) {
      break;
    }
    end++;
  }
  const raw = text.slice(from, end);
  return { delim: raw.replace(/['"\\]/g, ''), end, quoted: /['"\\]/.test(raw) };
}

/** `<<` / `<<-` `WORD` queues a heredoc; `<<<` and arithmetic shifts are ordinary text. */
const angle: Handler = (s, text, i) => {
  if (text[i + 1] !== '<') {
    return plain(s, text, i);
  }
  if (text[i + 2] === '<') {
    addChars(s, '<<<');
    return i + 2;
  }
  const strip = text[i + 2] === '-';
  let from = i + (strip ? 3 : 2);
  while (text[from] === ' ' || text[from] === '\t') {
    from++;
  }
  const { delim, end, quoted: wasQuoted } = readDelimiter(text, from);
  if (delim === '' || s.arith > 0 || s.heredocsOff || s.pending.length >= MAX_HEREDOCS) {
    addChars(s, '<<');
    return i + 1;
  }
  endWord(s);
  s.pending.push({ delim, strip, quoted: wasQuoted, seg: s.segments.length });
  return end - 1;
};

const UNQUOTED = new Map<string, Handler>([
  ["'", openQuote],
  ['"', openQuote],
  ['\\', escape],
  ['$', dollar],
  ['<', angle],
  ['(', paren],
  [')', paren],
  [' ', space],
  ['\t', space],
  ['\r', space],
  ...[';', '&', '|', '\n', '`'].map((c): [string, Handler] => [c, separator]),
]);

const DQ_ESCAPES = new Set(['"', '\\', '$', '`']);

/** Backslash inside quotes; `escapes` lists what it may escape (else the backslash stays). */
function quotedEscape(
  s: SplitState,
  text: string,
  i: number,
  escapes: ReadonlySet<string>,
): number {
  const next = text[i + 1];
  if (next === undefined || !escapes.has(next)) {
    s.word += '\\';
    return i;
  }
  s.word += next;
  return i + 1;
}

const SINGLE_ESCAPES = new Set(["'", '\\']);

function quoted(s: SplitState, text: string, i: number): number {
  const ch = text[i] ?? '';
  if (ch === (s.quote === '"' ? '"' : "'")) {
    s.quote = '';
  } else if (ch === '\\' && s.quote === '"') {
    return dqEscape(s, text, i);
  } else if (ch === '\\' && s.quote === "$'") {
    return quotedEscape(s, text, i, SINGLE_ESCAPES);
  } else {
    s.word += ch;
  }
  return i;
}

function dqEscape(s: SplitState, text: string, i: number): number {
  if (text[i + 1] === '\n') {
    return i + 1;
  }
  return quotedEscape(s, text, i, DQ_ESCAPES);
}

/** Delimiter line at `line`: `{body end, next}` of the heredoc body starting at `pos`, or null. */
function findTerminator(
  text: string,
  pos: number,
  p: Pending,
): { body: string; next: number } | null {
  let line = pos;
  for (;;) {
    const found = text.indexOf('\n', line);
    const end = found === -1 ? text.length : found;
    const content = text.slice(line, end);
    if ((p.strip ? content.replace(/^\t+/, '') : content) === p.delim) {
      return { body: text.slice(pos, line), next: Math.min(end + 1, text.length) };
    }
    if (found === -1) {
      return null;
    }
    line = found + 1;
  }
}

function attachBody(s: SplitState, p: Pending, body: string): void {
  const seg = s.segments[p.seg];
  if (seg !== undefined) {
    const join = (a: string): string => (a === '' ? body : `${a}\n${body}`);
    s.segments[p.seg] = {
      ...seg,
      heredoc: join(seg.heredoc),
      expanded: p.quoted ? seg.expanded : join(seg.expanded),
    };
  }
}

/**
 * Consume the queued heredoc bodies that start at `pos` (after a newline) into their segments.
 * An unterminated heredoc is left in place so its text is still checked as commands.
 */
function consumeHeredocs(s: SplitState, text: string, start: number): number {
  let pos = start;
  for (const p of s.pending) {
    const found = findTerminator(text, pos, p);
    if (found === null) {
      s.heredocsOff = true;
      break;
    }
    attachBody(s, p, found.body);
    pos = found.next;
  }
  s.pending = [];
  return pos;
}

const isSingle = (q: Quote): boolean => q === "'" || q === "$'";

function keep(spans: number[], start: number, end: number): void {
  if (spans.at(-1) === start) {
    spans[spans.length - 1] = end;
  } else {
    spans.push(start, end);
  }
}

/** Record `text[start, end)` in the masked copies it belongs to (a backslash-newline in neither). */
function mask(s: SplitState, text: string, before: Quote, start: number, end: number): void {
  if (end - start === 2 && text[start] === '\\' && text[start + 1] === '\n') {
    return;
  }
  if (before === '' && s.quote === '') {
    keep(s.bare, start, end);
  }
  if (!isSingle(before) && !isSingle(s.quote)) {
    keep(s.noSingle, start, end);
  }
}

function spanText(text: string, spans: readonly number[]): string {
  const parts: string[] = [];
  for (let k = 0; k < spans.length; k += 2) {
    parts.push(text.slice(spans[k], spans[k + 1]));
  }
  return parts.join('');
}

/** Runs of characters no handler treats specially, per quote state. */
const RUNS: Readonly<Record<Quote, RegExp>> = {
  '': /[^'"\\$<()\t\r\n ;&|`#]+/y,
  "'": /[^']+/y,
  '"': /[^"\\]+/y,
  "$'": /[^'\\]+/y,
};

/** Consume a plain run at `i` in one step; returns its end, or `i` when there is none. */
function takeRun(s: SplitState, text: string, i: number): number {
  const re = RUNS[s.quote];
  re.lastIndex = i;
  if (!re.test(text)) {
    return i;
  }
  const chunk = text.slice(i, re.lastIndex);
  s.word += chunk;
  s.inWord = true;
  mask(s, text, s.quote, i, re.lastIndex);
  return re.lastIndex;
}

/** A `#` at a word boundary outside quotes starts a comment: its end (the newline), else `i`. */
function commentEnd(s: SplitState, text: string, i: number): number {
  if (s.quote !== '' || text[i] !== '#' || s.inWord) {
    return i;
  }
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}

/** Split a command line into segments and masked copies, linear in its length. */
export function parseShell(text: string): ShellParse {
  const s: SplitState = {
    segments: [],
    words: [],
    word: '',
    inWord: false,
    quote: '',
    piped: false,
    pending: [],
    arith: 0,
    lineEnd: false,
    heredocsOff: false,
    bare: [],
    noSingle: [],
  };
  let i = 0;
  while (i < text.length) {
    const run = takeRun(s, text, i);
    if (run > i) {
      i = run;
      continue;
    }
    const comment = commentEnd(s, text, i);
    if (comment > i) {
      i = comment;
      continue;
    }
    const before = s.quote;
    const start = i;
    i = before === '' ? (UNQUOTED.get(text[i] ?? '') ?? plain)(s, text, i) : quoted(s, text, i);
    mask(s, text, before, start, i + 1);
    i++;
    if (s.lineEnd) {
      s.lineEnd = false;
      i = s.pending.length > 0 ? consumeHeredocs(s, text, i) : i;
    }
  }
  endSegment(s, '', '');
  return {
    segments: s.segments,
    bare: spanText(text, s.bare),
    noSingle: spanText(text, s.noSingle),
  };
}

/** Split a command line into segments of words, honouring quotes and backslash escapes. */
export function splitShell(text: string): readonly Segment[] {
  return parseShell(text).segments;
}

const PREFIXES = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'nohup',
  'time',
  'exec',
  'nice',
  'timeout',
  'xargs',
  'busybox',
  'setsid',
  'stdbuf',
  'ionice',
]);
/** Shell keywords that begin a command: `then rm …`, `do rm …`, `{ rm …`, `! rm …`. */
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'case',
  'esac',
  '{',
  '}',
  '!',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Prefix flags whose value is the next word: `sudo -u root rm …`, `nice -n 10 rm …`. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a']),
  stdbuf: new Set(['-i', '-o', '-e']),
};

/** Words a prefix's flag at `i` spans (1, or 2 when its value is the next word); 0 if none. */
function prefixFlagSpan(prefix: string, words: readonly string[], i: number): number {
  const w = words[i] ?? '';
  if (prefix === '' || !w.startsWith('-')) {
    return 0;
  }
  return VALUE_FLAGS[prefix]?.has(w) === true && i + 1 < words.length ? 2 : 1;
}

/** Drop `sudo`, `env`, `timeout 5`, `VAR=value` and similar prefixes so `words[0]` is the command. */
export function commandWords(words: readonly string[]): readonly string[] {
  let i = 0;
  let prefix = '';
  let durationDue = false;
  while (i < words.length) {
    const w = words[i] ?? '';
    const span = prefixFlagSpan(prefix, words, i);
    if (span > 0) {
      i += span;
    } else if (durationDue && !ASSIGNMENT.test(w)) {
      durationDue = false;
      i++;
    } else if (prefix === '' && KEYWORDS.has(w)) {
      i++;
    } else if (PREFIXES.has(w) || ASSIGNMENT.test(w)) {
      if (PREFIXES.has(w)) {
        prefix = w;
        durationDue = w === 'timeout';
      }
      i++;
    } else {
      break;
    }
  }
  return words.slice(i);
}

/** The basename of a command word: `/usr/bin/rm` → `rm`. */
export function baseName(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}

/** Scanner contexts inside a substitution: `$(` ('S'), a bare `(` ('P') and a `"` ('D'). */
interface Scan {
  readonly text: string;
  readonly stack: string[];
  readonly out: string[];
  start: number;
}

/** A backtick substitution at `i`: its body runs to the next unescaped backtick. */
function backtick(sc: Scan, i: number): number {
  let j = i + 1;
  while (j < sc.text.length && sc.text[j] !== '`') {
    j += sc.text[j] === '\\' ? 2 : 1;
  }
  sc.out.push(sc.text.slice(i + 1, j));
  return j + 1;
}

function open(sc: Scan, kind: string, at: number, next: number): number {
  if (sc.stack.length === 0) {
    sc.start = next;
  }
  sc.stack.push(kind);
  return at;
}

function baseStep(sc: Scan, i: number): number {
  const c = sc.text[i];
  if (c === '\\') {
    return i + 2;
  }
  if (c === '$' && sc.text[i + 1] === '(') {
    return open(sc, 'S', i + 2, i + 2);
  }
  return c === '`' ? backtick(sc, i) : i + 1;
}

function innerStep(sc: Scan, i: number, top: string): number {
  const c = sc.text[i];
  if (c === '\\') {
    return i + 2;
  }
  if (c === '$' && sc.text[i + 1] === '(') {
    return open(sc, 'S', i + 2, i + 2);
  }
  return top === 'D' ? dqStep(sc, c, i) : codeStep(sc, c, i);
}

function dqStep(sc: Scan, c: string | undefined, i: number): number {
  if (c === '"') {
    sc.stack.pop();
  }
  return i + 1;
}

function codeStep(sc: Scan, c: string | undefined, i: number): number {
  if (c === "'") {
    const j = sc.text.indexOf("'", i + 1);
    return j === -1 ? i + 1 : j + 1;
  }
  if (c === '"' || c === '(') {
    return open(sc, c === '"' ? 'D' : 'P', i + 1, i + 1);
  }
  if (c === ')') {
    sc.stack.pop();
    if (sc.stack.length === 0) {
      sc.out.push(sc.text.slice(sc.start, i));
    }
  }
  return i + 1;
}

/**
 * The scripts of the outermost `$(…)` and backtick substitutions in `text`, and the text of an
 * unterminated `$(` (`tail`, to the end), found in one forward pass so repeated openers cost nothing extra. Nested ones
 * are the caller's recursion.
 */
export function substitutions(text: string): { scripts: readonly string[]; tail: string } {
  const sc: Scan = { text, stack: [], out: [], start: 0 };
  let i = 0;
  while (i < text.length) {
    const top = sc.stack.at(-1);
    i = top === undefined ? baseStep(sc, i) : innerStep(sc, i, top);
  }
  return { scripts: sc.out, tail: sc.stack.length > 0 ? text.slice(sc.start) : '' };
}
