import { redactSecrets } from '@ziptie-soft/local-decider-core';

/** Upper bound on a graceful shutdown; after it the process exits whatever is still pending. */
const SHUTDOWN_HARD_MS = 10_000;

export interface ShutdownProcess {
  once(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void): unknown;
}

export interface ShutdownOptions {
  readonly proc: ShutdownProcess;
  readonly gateway: { close(): Promise<void>; flushLog(): void };
  readonly log: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly hardMs?: number;
}

function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw.split('\n', 1)[0] ?? '').text.slice(0, 300);
}

/**
 * Close the gateway on SIGINT or SIGTERM and always exit: a failing `close()` is logged and exits
 * with 1, and an unref'd timer exits after `hardMs` if it hangs. Every path ends in `exit`, whose
 * `exit` event writes the queued log records and the child reaper stops supervised engines.
 */
export function installShutdown(options: ShutdownOptions): void {
  const { proc, gateway, log, exit } = options;
  let code = 0;
  let started = false;
  const shutdown = (): void => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      log(`local-decider: shutdown exceeded ${String(options.hardMs ?? SHUTDOWN_HARD_MS)} ms`);
      exit(1);
    }, options.hardMs ?? SHUTDOWN_HARD_MS);
    timer.unref();
    gateway
      .close()
      .catch((error: unknown) => {
        code = 1;
        log(`local-decider: shutdown failed: ${describe(error)}`);
      })
      .finally(() => {
        clearTimeout(timer);
        exit(code);
      });
  };
  // Covers the process.exit paths (guards, signals, the hard timer) that skip gateway.close().
  proc.once('exit', () => gateway.flushLog());
  proc.once('SIGINT', shutdown);
  proc.once('SIGTERM', shutdown);
}
