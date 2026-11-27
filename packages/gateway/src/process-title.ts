import { realpathSync } from 'node:fs';
import { basename, sep } from 'node:path';

const TITLE_PREFIX = 'local-decider: ';
const ALLOWED_TITLE = /[^A-Za-z0-9._:/@+\- ]/g;
const TITLE_LIMIT = 64;

/** Build a short title from configured ids; never include filesystem paths or request text. */
export function processTitle(engine: string, model: string): string {
  const safe = `${engine} ${model}`.replaceAll(ALLOWED_TITLE, '_').replaceAll(/\s+/g, ' ').trim();
  return `${TITLE_PREFIX}${safe}`.slice(0, TITLE_LIMIT);
}

/**
 * Whether a process title may replace `argv[0]` of `binary`. A version-manager shim (mise, asdf)
 * or a multi-call binary (busybox) picks what to run from `argv[0]`, so a title would break it:
 * skip a path under a `shims` directory or a symlink to a binary of another name.
 */
export function titleApplies(binary: string): boolean {
  if (binary.split(sep).includes('shims')) {
    return false;
  }
  try {
    return basename(realpathSync(binary)) === basename(binary);
  } catch {
    return false;
  }
}
