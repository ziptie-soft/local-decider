import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MODELS } from './models.ts';

/** `models--Org--Name/snapshots/<rev>` holds at least one file (any revision when none given). */
export function hfCached(hfCache: string, repo: string, revision?: string): boolean {
  const snapshots = join(hfCache, `models--${repo.replace('/', '--')}`, 'snapshots');
  if (!existsSync(snapshots)) {
    return false;
  }
  const revs = revision === undefined ? readdirSync(snapshots) : [revision];
  return revs.some((rev) => {
    const dir = join(snapshots, rev);
    return existsSync(dir) && readdirSync(dir).length > 0;
  });
}

/** The Hugging Face hub cache directory, honouring HF_HUB_CACHE then HF_HOME. */
export function hfCacheDir(...envs: readonly (NodeJS.ProcessEnv | undefined)[]): string {
  const pick = (name: string): string | undefined => {
    for (const env of envs) {
      const value = env?.[name];
      if (value !== undefined && value !== '') {
        return value;
      }
    }
    return undefined;
  };
  return (
    pick('HF_HUB_CACHE') ?? join(pick('HF_HOME') ?? join(homedir(), '.cache', 'huggingface'), 'hub')
  );
}

/**
 * The cached snapshot directory of a catalogue model's adapter at its pinned revision, when
 * present. `serve <dir>` loads it as-is, so a newer `main` can never be fetched in its place.
 */
export function pinnedCheckpoint(hfCache: string, model: string): string | undefined {
  const revision = MODELS.find((m) => m.id === model)?.revisions?.[model];
  if (revision === undefined || !hfCached(hfCache, model, revision)) {
    return undefined;
  }
  return join(hfCache, `models--${model.replace('/', '--')}`, 'snapshots', revision);
}
