/**
 * Linear-time checks catch quadratic blowups, which take hours on these inputs, not constant
 * factors. Shared CI runners with coverage on are 2-4x slower than a dev machine.
 */
export const LINEAR_BOUND_MS = 5000 * (process.env['CI'] ? 4 : 1);

/** CPU milliseconds `fn` takes; unlike wall time, a busy machine does not inflate it. */
export function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}
