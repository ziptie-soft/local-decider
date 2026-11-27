import { createConnection, type NetConnectOpts } from 'node:net';

export type ConnectionProbe = 'connected' | 'refused' | 'other';

/** Test whether a TCP or Unix socket endpoint accepts a connection within `timeoutMs`. */
export function probeConnection(
  target: NetConnectOpts,
  timeoutMs: number,
): Promise<ConnectionProbe> {
  return new Promise((resolve) => {
    const socket = createConnection(target);
    let finished = false;
    const finish = (result: ConnectionProbe): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish('other'));
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'other'),
    );
  });
}
