/**
 * The decider never auto-allows a call that touches the gateway's own config directory (its
 * `config.yaml` and `policies/`): that would let an agent loosen the policy that judges it. The
 * request stays with the user. A path counts when it is inside the directory lexically or after
 * symlinks resolve, and a shell command or patch counts when any word or target names such a path.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { patchTargets } from './core/patch.ts';
import { splitShell } from './core/shell.ts';
import { asRecord, commandOf } from './core/subject.ts';
import { configDir } from './deps.ts';

const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path'];
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command']);

/** True when `path` is `dir` or below it, compared by whole segments (`/cfg` is not `/cfg2`). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `path` with symlinks resolved in its deepest existing ancestor; the path itself when none is. */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.toReversed());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return path;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The path a shell word names: `>file`, `--out=/x` unwrapped; none for flags and `~`/`$` words. */
function wordTarget(word: string): string | undefined {
  const bare = word.replace(/^\d*>{1,2}/, '').replace(/^--?[\w-]+=/, '');
  return bare === '' || /^[-~$]/.test(bare) ? undefined : bare;
}

/** Every path a call names: its path fields, a shell command's words, or a patch's targets. */
function namedPaths(tool: string, input: unknown): string[] {
  const fields = asRecord(input);
  const fromFields = PATH_FIELDS.map((key) => fields?.[key]).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const command = commandOf({ tool_input: input });
  if (command === undefined) {
    return fromFields;
  }
  if (tool === 'apply_patch') {
    return [...fromFields, ...(patchTargets(command) ?? [])];
  }
  if (!SHELL_TOOLS.has(tool)) {
    return fromFields;
  }
  const words = splitShell(command).flatMap((segment) => segment.words);
  return [...fromFields, ...words.map(wordTarget).filter((w): w is string => w !== undefined)];
}

/** True when the working directory, or a path the call names, is inside the config directory. */
export function touchesConfig(cwd: string, tool: string, input: unknown): boolean {
  const dir = resolve(configDir(process.env));
  const realDir = realPath(dir);
  const hits = (path: string): boolean => within(dir, path) || within(realDir, realPath(path));
  return [cwd, ...namedPaths(tool, input).map((path) => resolve(cwd, path))].some(hits);
}
