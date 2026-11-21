import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Index of `starttime` (field 22 of `/proc/<pid>/stat`) among the fields after `comm`. */
const STARTTIME_AFTER_COMM = 22 - 3;

/** Ticks since boot at which the process started; `comm` may hold spaces and parentheses. */
export function parseProcStat(stat: string): string | undefined {
  const end = stat.lastIndexOf(')');
  if (end === -1) return undefined;
  const value = stat
    .slice(end + 1)
    .trim()
    .split(' ')[STARTTIME_AFTER_COMM];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}

/**
 * An opaque token that identifies one incarnation of a pid, so a recycled pid compares unequal.
 * Linux: the `starttime` of `/proc/<pid>/stat`. macOS: `ps -o lstart=` (spawned without a shell,
 * fixed arguments, the pid as a validated integer). Elsewhere, or when the process is gone or
 * cannot be inspected: undefined, and callers fall back to pid liveness.
 */
export function processStartToken(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      return parseProcStat(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === '' ? undefined : out.replaceAll(/\s+/g, ' ');
    }
  } catch {
    // gone or not inspectable
  }
  return undefined;
}
