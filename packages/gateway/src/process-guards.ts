import { redactSecrets } from '@ziptie-soft/local-decider-core';

/** At most one unhandled-rejection line per this long; the rest are counted. */
const REJECTION_LOG_INTERVAL_MS = 10_000;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_FRAMES = 5;

export interface GuardProcess {
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (reason: unknown) => void,
  ): unknown;
}

export interface ProcessGuardOptions {
  readonly proc: GuardProcess;
  readonly log: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly now?: () => number;
}

/** `<name>: <first line of message, redacted and cut>` plus a few stack frames, on one line. */
function describeError(reason: unknown): string {
  const error = reason instanceof Error ? reason : undefined;
  const name = error?.name ?? 'non-error';
  const raw = error?.message ?? String(reason);
  const firstLine = redactSecrets(raw.split('\n', 1)[0] ?? '').text.slice(0, MAX_MESSAGE_CHARS);
  const frames = (error?.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => redactSecrets(line.trim()).text);
  return [`${name}: ${firstLine}`, ...frames].join(' | ');
}

/**
 * Last-resort handlers for the long-running gateway. An unhandled rejection is logged (rate
 * limited) and the gateway carries on; an uncaught exception is logged and the process exits
 * with 1, because continuing after one is unsafe. The service manager restarts the gateway.
 */
export function installProcessGuards(options: ProcessGuardOptions): void {
  const { proc, log, exit } = options;
  const now = options.now ?? Date.now;
  let lastLogged: number | undefined;
  let suppressed = 0;
  proc.on('unhandledRejection', (reason) => {
    const at = now();
    if (lastLogged !== undefined && at - lastLogged < REJECTION_LOG_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    lastLogged = at;
    const extra = suppressed === 0 ? '' : ` (${String(suppressed)} more suppressed)`;
    suppressed = 0;
    log(`local-decider: unhandled rejection: ${describeError(reason)}${extra}`);
  });
  proc.on('uncaughtException', (error) => {
    log(`local-decider: uncaught exception: ${describeError(error)}`);
    exit(1);
  });
}
