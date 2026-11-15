import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';

const VERSION_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;

interface CachedVersion {
  readonly mtimeMs: number;
  readonly value: string;
}

const versions = new Map<string, CachedVersion>();

function versionOutput(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['--version'],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, shell: false, timeout: VERSION_TIMEOUT_MS },
      // llama-server prints its version on stderr.
      (error, stdout, stderr) => (error === null ? resolve(`${stdout}\n${stderr}`) : reject(error)),
    );
  });
}

export async function llamaServerVersion(binary: string | undefined): Promise<string | null> {
  if (binary === undefined) return null;
  let real: string;
  let mtimeMs: number;
  let size: number;
  try {
    real = realpathSync(binary);
    const stat = statSync(real);
    if (!stat.isFile()) return null;
    ({ mtimeMs, size } = stat);
  } catch {
    return null;
  }
  const cached = versions.get(real);
  if (cached?.mtimeMs === mtimeMs) return cached.value;
  const value = (await parseVersion(real)) ?? `stamp:${String(size)}-${String(mtimeMs)}`;
  versions.set(real, { mtimeMs, value });
  return value;
}

async function parseVersion(binary: string): Promise<string | null> {
  try {
    const output = await versionOutput(binary);
    // Current builds print `version: 1.0.0-dev (build 12359, commit …)`; older ones `version: 12318`.
    const match = /\bbuild\s+(\d+)/.exec(output) ?? /version:\s*(\d+)\s*(?:\(|$)/m.exec(output);
    return match?.[1] === undefined ? null : `b${match[1]}`;
  } catch {
    return null;
  }
}
