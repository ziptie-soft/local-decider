import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PERMISSION_DEADLINE_MS } from '../server/permission.ts';
import { ROUTING_BUDGET_MS } from '../server/routing.ts';
import { DECIDE_TIMEOUT_MS } from '../server/turn.ts';
import { GATEWAY_POLICIES, HOOK_POLICIES, PLUGIN_MODES } from '../shared/constants.ts';
import { DECISION_KINDS } from '../shared/decision-kinds.ts';

describe('DECISION_KINDS', () => {
  it('has exactly the gateway policies', () => {
    assert.deepEqual(Object.keys(DECISION_KINDS), [...GATEWAY_POLICIES]);
  });

  it('has non-empty copy for every kind and mode', () => {
    for (const info of Object.values(DECISION_KINDS)) {
      for (const text of [info.title, info.decides, info.askedBy]) {
        assert.notEqual(text.trim(), '');
      }
      for (const mode of PLUGIN_MODES) {
        assert.notEqual(info.modes[mode].trim(), '');
      }
    }
  });

  it('keeps a plugin mode exactly for the hook policies', () => {
    for (const id of GATEWAY_POLICIES) {
      const hook = (HOOK_POLICIES as readonly string[]).includes(id);
      assert.equal(DECISION_KINDS[id].pluginMode, hook, id);
    }
  });

  it('matches the budgets the callers use', () => {
    for (const info of Object.values(DECISION_KINDS)) {
      assert.equal(info.budgets.hooks, 1000);
    }
    assert.equal(DECISION_KINDS['command-risk'].budgets.paseo, null);
    assert.equal(DECISION_KINDS.permission.budgets.paseo, PERMISSION_DEADLINE_MS - 500);
    assert.equal(DECISION_KINDS.routing.budgets.paseo, ROUTING_BUDGET_MS - 500);
    assert.equal(DECISION_KINDS['turn-outcome'].budgets.paseo, DECIDE_TIMEOUT_MS - 500);
  });
});
