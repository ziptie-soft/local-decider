import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { EngineContext, ModelDescriptor } from '../descriptor.ts';
import { hfCacheDir, hfCached } from './hf-cache.ts';
import { MODELS } from './models.ts';

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** True when another catalogue model is fully cached and also needs `repo`. */
function sharedRepo(cache: string, repo: string, owner: string): boolean {
  return MODELS.some(
    (other) =>
      other.id !== owner &&
      (other.artifacts ?? []).includes(repo) &&
      (other.artifacts ?? []).every((a) => hfCached(cache, a, other.revisions?.[a])),
  );
}

/**
 * Deletes a model's Hugging Face cache repos. A repo another installed catalogue model also uses
 * (a shared base checkpoint) is kept so that model keeps working.
 */
export async function removeStrandsModel(
  model: ModelDescriptor<'strands-decider'>,
  ctx: EngineContext,
): Promise<void> {
  const cache = hfCacheDir(ctx.tools?.env, ctx.env);
  for (const repo of model.artifacts ?? []) {
    if (!REPO.test(repo) || sharedRepo(cache, repo, model.id)) {
      continue;
    }
    await rm(join(cache, `models--${repo.replace('/', '--')}`), { recursive: true, force: true });
  }
}
