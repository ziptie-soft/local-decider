import { rm } from 'node:fs/promises';

import type { EngineContext, ModelDescriptor } from '../descriptor.ts';
import { ggufPath } from './models.ts';
import { recordPath } from './verified.ts';

/** Deletes a pinned GGUF and its verification record; a missing file is not an error. */
export async function removeLlamaModel(
  model: ModelDescriptor<'llama-vulkan'>,
  ctx: EngineContext,
): Promise<void> {
  const path = ggufPath(ctx.paths, model.id);
  if (path === undefined) {
    throw new Error(`${model.id} has no pinned GGUF`);
  }
  await rm(recordPath(path), { force: true });
  await rm(path, { force: true });
}
