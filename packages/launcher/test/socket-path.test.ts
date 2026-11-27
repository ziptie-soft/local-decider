import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gatewaySocketPath } from '../src/socket-path.ts';

describe('gatewaySocketPath', () => {
  it('uses the same POSIX path and disables Windows or overlong paths', () => {
    assert.equal(
      gatewaySocketPath('/tmp/local-decider/run', 'linux'),
      '/tmp/local-decider/run/gateway.sock',
    );
    assert.equal(gatewaySocketPath('/tmp/local-decider/run', 'win32'), null);
    assert.equal(gatewaySocketPath(`/tmp/${'x'.repeat(100)}`, 'linux'), null);
    assert.equal(gatewaySocketPath(`/tmp/${'é'.repeat(46)}`, 'darwin'), null);
  });
});
