/**
 * Path checks shared by the hook guard and the Claude Code mod: whether a path leaves the working
 * directory or names a protected place. Pure string work (no fs, so symlinks are not resolved) and
 * no `node:` imports, so the mod can bundle it.
 */
import { resolveSegments } from '@ziptie-soft/local-decider-core';

const PROTECTED_DIRS = new Set(['.git', '.claude', '.vscode', '.idea', '.husky', '.ssh']);
const PROTECTED_FILES = new Set([
  '.mcp.json',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.cshrc',
  '.kshrc',
  'config.fish',
]);

/** Segments of `path` under `cwd`, or null when it resolves outside. */
function insideCwd(cwd: string, path: string): string[] | null {
  const base = resolveSegments('', cwd);
  const target = resolveSegments(cwd, path);
  const inside = base.every((part, i) => target[i] === part);
  return inside ? target.slice(base.length) : null;
}

/** Lower-cased segments of `path`: the part under `cwd` when inside it, else the full path. */
export function pathParts(cwd: string, path: string): string[] {
  const normal = path.replaceAll('\\', '/');
  const parts = insideCwd(cwd, normal) ?? resolveSegments(cwd, normal);
  return parts.map((part) => part.toLowerCase());
}

function isProtected(relative: readonly string[]): boolean {
  const parts = relative.map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  return (
    parts.some(
      (part, i) => PROTECTED_DIRS.has(part) || (part === '.github' && parts[i + 1] === 'workflows'),
    ) ||
    PROTECTED_FILES.has(name) ||
    name === '.env' ||
    name.startsWith('.env.')
  );
}

/** A reason when `path` is outside the working directory or a protected file; else null. */
export function pathBlock(cwd: string, path: string): string | null {
  if (path === '' || path === '/dev/null') {
    return null;
  }
  const relative = insideCwd(cwd, path.replaceAll('\\', '/'));
  if (relative === null) {
    return `path outside the working directory: ${path}`;
  }
  return isProtected(relative) ? `protected path: ${path}` : null;
}
