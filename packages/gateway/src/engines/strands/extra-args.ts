import type { z } from 'zod';

/**
 * `serve` flags the gateway sets itself: the loopback bind and port, the device and model it
 * resolved, and the settings that have their own config fields. `extraArgs` may not override them.
 */
export const RESERVED_SERVE_FLAGS: readonly string[] = [
  '--host',
  '--port',
  '--device',
  '--model-name',
  '--revision',
  '--max-batch',
  '--max-concurrency',
];

function flagOf(arg: string): string | undefined {
  return arg.startsWith('--') ? arg.split('=', 1)[0] : undefined;
}

/** Issues for reserved flags (`--flag` or `--flag=value`) and the bare value after one. */
export function checkExtraArgs(args: readonly string[], ctx: z.RefinementCtx): void {
  let previousReserved: string | undefined;
  args.forEach((arg, index) => {
    const flag = flagOf(arg);
    if (flag !== undefined && RESERVED_SERVE_FLAGS.includes(flag)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `${flag} is set by the gateway (host, port, device, model and batching have their own settings) and cannot go in extraArgs`,
      });
      previousReserved = arg.includes('=') ? undefined : flag;
      return;
    }
    if (flag === undefined && previousReserved !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `"${arg}" is the value of ${previousReserved}, which cannot go in extraArgs`,
      });
    }
    previousReserved = undefined;
  });
}
