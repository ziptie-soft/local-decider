import { constants, fchmodSync, fstatSync, mkdirSync, openSync, closeSync } from 'node:fs';

import type { Paths } from './paths.ts';

const PRIVATE_MODE = 0o700;

/** Create and verify runtime directories using descriptors so checks apply to opened objects. */
export function ensurePrivatePaths(paths: Paths, includeGateway = false): void {
  const dirs = [
    paths.data,
    paths.run,
    paths.logs,
    ...(includeGateway ? [`${paths.data}/gateway`] : []),
  ];
  for (const dir of dirs) ensurePrivateDirectory(dir);
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_MODE });
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`unsafe private directory: ${dir}`);
    }
    if ((stat.mode & 0o022) !== 0) fchmodSync(fd, PRIVATE_MODE);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
