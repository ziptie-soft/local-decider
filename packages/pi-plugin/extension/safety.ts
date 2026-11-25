/**
 * Deterministic safety checks run before any gateway call. `hard` is a guard denial, `ask` is a
 * reason to keep the call with the user, and `autoAllow` says whether the decider may allow the
 * call without asking. Nothing here allows a call on its own, and nothing blocks except `hard`.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { deterministicBlock } from './core/block.ts';
import { guardCommand } from './core/guard.ts';
import { splitShell } from './core/shell.ts';
import { mappedInput } from './tools.ts';
import type { ToolDescriptor } from './tools.ts';

export interface SafetyResult {
  readonly hard: string | null;
  readonly ask: string | null;
  readonly autoAllow: boolean;
}

export interface SafetyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/** The gateway config dir (`LOCAL_DECIDER_CONFIG_DIR`, XDG, `~/.config`) and pi's agent dir. */
export function protectedDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const gateway =
    env['LOCAL_DECIDER_CONFIG_DIR'] ??
    join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'local-decider');
  // pi: `PI_CODING_AGENT_DIR` (a leading `~` expands to home), else `~/.pi/agent`.
  const override = env['PI_CODING_AGENT_DIR'];
  const agent =
    override === undefined || override === ''
      ? join(home, '.pi', 'agent')
      : override === '~' || override.startsWith('~/')
        ? join(home, override.slice(1))
        : override;
  return [resolve(gateway), resolve(agent)];
}

/** True when `path` is `dir` or below it, compared by whole segments. */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `path` with symlinks resolved in its deepest existing ancestor; the path when none is. */
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

/** The path a shell word names; `>file` and `--out=/x` unwrapped, `~` and `$HOME` expanded. */
function wordTarget(word: string, home: string): string | undefined {
  const bare = word.replace(/^\d*>{1,2}/, '').replace(/^--?[\w-]+=/, '');
  const expanded = bare.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  return expanded === '' || /^[-~$]/.test(expanded) ? undefined : expanded;
}

function namedPaths(d: ToolDescriptor, home: string): string[] {
  if (d.kind === 'edit') {
    return d.path === undefined ? [] : [d.path.replace(/^~(?=\/|$)/, home)];
  }
  if ((d.kind !== 'shell' && d.kind !== 'powershell') || d.command === undefined) {
    return [];
  }
  const words = splitShell(d.command).flatMap((segment) => segment.words);
  return words.map((w) => wordTarget(w, home)).filter((w): w is string => w !== undefined);
}

/** True when the cwd or a path the call names is inside a protected config directory. */
function touchesConfig(
  d: ToolDescriptor,
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): boolean {
  // Project-local `.pi` (pi's CONFIG_DIR_NAME default) loads settings and extensions once trusted.
  const dirs = [...protectedDirs(env, home), resolve(cwd, '.pi')];
  const hits = (path: string): boolean =>
    dirs.some((dir) => within(dir, path) || within(realPath(dir), realPath(path)));
  return [cwd, ...namedPaths(d, home).map((path) => resolve(cwd, path))].some(hits);
}

function guardResult(d: ToolDescriptor): { hard: string | null; ask: string | null } {
  if (d.kind !== 'shell' || d.command === undefined) {
    return { hard: null, ask: null };
  }
  const hit = guardCommand(d.command);
  if (hit === null) {
    return { hard: null, ask: null };
  }
  return hit.ask === true ? { hard: null, ask: hit.reason } : { hard: hit.reason, ask: null };
}

/** The deterministic checks for one call; `autoAllow` is true only when every one is clear. */
export function checkSafety(
  d: ToolDescriptor,
  cwd: string,
  platform: string,
  options: SafetyOptions = {},
): SafetyResult {
  const { hard, ask } = guardResult(d);
  const env = options.env ?? process.env;
  const input = mappedInput(d);
  const gated = (d.kind === 'shell' || d.kind === 'edit') && platform !== 'win32';
  const blocked =
    input === undefined || d.guardTool === undefined
      ? 'no usable command or path'
      : deterministicBlock(d.guardTool, input, cwd);
  const config = touchesConfig(d, cwd, env, options.home ?? homedir());
  return {
    hard,
    ask: ask ?? (config ? 'touches local-decider or pi configuration' : null),
    autoAllow: gated && hard === null && ask === null && blocked === null && !config,
  };
}
