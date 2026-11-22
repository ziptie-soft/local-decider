import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { engineProjectDir } from '../../engine-install.ts';
import type { Paths } from '../../paths.ts';

export interface StrandsVenvPackages {
  readonly strands: string | null;
  readonly torch: string | null;
}

function packageVersion(names: readonly string[], packages: readonly string[]): string | null {
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const pkg of packages) {
      const prefix = `${pkg}-`;
      if (lower.startsWith(prefix) && lower.endsWith('.dist-info')) {
        return name.slice(prefix.length, -'.dist-info'.length);
      }
    }
  }
  return null;
}

/**
 * The strands-decider and torch versions installed in the managed venv, read from the
 * `*.dist-info` directories. Read-only; `null` when there is no venv or no strands-decider in it.
 */
export function strandsVenvPackages(paths: Paths): StrandsVenvPackages | null {
  const venv = join(paths.venvs, 'strands-decider');
  try {
    const pyDirs = readdirSync(join(venv, 'lib')).filter((name) => /^python3\.\d+$/.test(name));
    for (const version of pyDirs) {
      const names = readdirSync(join(venv, 'lib', version, 'site-packages'));
      const strands = packageVersion(names, ['strands_decider', 'strands-decider']);
      if (strands !== null) return { strands, torch: packageVersion(names, ['torch']) };
    }
  } catch {
    return null;
  }
  return null;
}

/** The `strands-decider==X.Y.Z` pin of the bundled uv project; `null` when unreadable. */
export function pinnedStrandsVersion(project: string = engineProjectDir()): string | null {
  try {
    const text = readFileSync(join(project, 'pyproject.toml'), 'utf8');
    return /"strands-decider==([^"\s]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A one-line report when the managed venv holds a different strands-decider than the pin, else
 * `null` (matching, no venv, or no pin). Never installs or modifies anything.
 */
export function strandsPinMismatch(paths: Paths, project?: string): string | null {
  const installed = strandsVenvPackages(paths)?.strands;
  const pinned = pinnedStrandsVersion(project);
  if (installed === undefined || installed === null || pinned === null || installed === pinned) {
    return null;
  }
  return `strands-decider venv has ${installed}, pinned ${pinned}; run local-decider engine install`;
}
