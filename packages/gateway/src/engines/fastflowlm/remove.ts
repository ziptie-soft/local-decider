import { probe } from '../../toolchain-probe.ts';
import type { EngineContext, ModelDescriptor } from '../descriptor.ts';

/** `flm remove <tag>`; flm exits 0 on errors, so an `[ERROR]` line fails the removal. */
export async function removeFlmModel(
  model: ModelDescriptor<'fastflowlm'>,
  ctx: EngineContext,
): Promise<void> {
  const flm = ctx.tools?.flm;
  if (flm === undefined) {
    throw new Error('FastFlowLM is not installed');
  }
  const output = await probe(flm, ['remove', model.id], ctx.tools?.env, 60_000);
  const error = output.split('\n').find((line) => line.includes('[ERROR]'));
  if (error !== undefined) {
    throw new Error(error.replace(/^\s*\[ERROR\]\s*/, '').slice(0, 300));
  }
}
