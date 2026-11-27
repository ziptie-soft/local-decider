import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gatewaySocketPath as launcherPath } from '../../launcher/src/socket-path.ts';
import { gatewaySocketPath as gatewayPath } from '../src/socket-path.ts';

describe('gateway socket path contract', () => {
  it('keeps launcher and published gateway path decisions identical', () => {
    for (const runDir of [
      '/tmp/local-decider/run',
      `/tmp/${'x'.repeat(90)}`,
      `/tmp/${'é'.repeat(50)}`,
    ]) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        assert.equal(gatewayPath(runDir, platform), launcherPath(runDir, platform));
      }
    }
  });
});
