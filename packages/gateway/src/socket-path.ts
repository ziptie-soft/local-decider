import { join } from 'node:path';

/** Published-gateway copy of the launcher rule; keep agreement covered by a parity test. */
export function gatewaySocketPath(
  runDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') return null;
  const pathBytes = Buffer.from(join(runDir, 'gateway.sock'));
  return pathBytes.byteLength <= 100 ? pathBytes.toString() : null;
}
