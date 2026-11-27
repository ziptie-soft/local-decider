import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shared client rule: POSIX sockets are disabled when sun_path would exceed 100 bytes. */
export function gatewaySocketPath(
  runDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') return null;
  const path = join(runDir, 'gateway.sock');
  return Buffer.byteLength(path) > 100 ? null : path;
}

/** Resolve the same runtime socket from a client's sanitized environment. */
export function gatewaySocketPathForEnv(
  env: NodeJS.ProcessEnv,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const data =
    env['LOCAL_DECIDER_HOME'] ??
    join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'local-decider');
  return gatewaySocketPath(join(data, 'run'), platform);
}
