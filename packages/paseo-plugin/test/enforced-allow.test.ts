/**
 * `shared/decision.ts` copies core's `isEnforcedAllow` (the published plugin cannot import core at
 * runtime). Core is a devDependency, so this test may import it and fails when the copies drift.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isEnforcedAllow as coreIsEnforcedAllow } from '@ziptie-soft/local-decider-core';

import { isEnforcedAllow } from '../shared/decision.ts';
import { response } from './fakes.ts';

const fixtures = [
  response({ action: 'allow', mode: 'act', enforced: true }),
  response({ action: 'allow', mode: 'shadow', enforced: false }),
  response({ action: 'allow', mode: 'act', enforced: false }),
  response({ action: 'allow', mode: 'off', enforced: false }),
  response({ action: 'deny', mode: 'act', enforced: true }),
  response({ action: 'ask', mode: 'act', enforced: true }),
  response({ action: 'log', mode: 'act', enforced: false }),
  response({ action: 'allow', mode: 'act', enforced: false, error: 'engine down' }),
  response({ action: 'route:fast', mode: 'act', enforced: true, route: { preset: 'fast' } }),
];

it('the plugin isEnforcedAllow agrees with core on every valid reply', () => {
  assert.ok(fixtures.some((reply) => coreIsEnforcedAllow(reply)), 'a fixture is an allow');
  for (const reply of fixtures) {
    assert.equal(isEnforcedAllow(reply), coreIsEnforcedAllow(reply), JSON.stringify(reply));
  }
});
