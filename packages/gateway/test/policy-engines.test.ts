import type { Mode } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PolicySelection } from '../src/config.ts';
import { laneKey, PRIMARY_LANE } from '../src/engine-lane.ts';
import {
  MAX_POLICY_LANES,
  PolicyEngines,
  type LanePlanInput,
  type LanePlan,
  type LanePlanDeps,
  type PlanSelection,
} from '../src/policy-engines.ts';

const BUDGET_GB = 10;
const FLM_REASON = 'fastflowlm serves one model at a time';
const NO_FIT = 'does not fit with the default model';

/** Memory each fake model needs; a model not listed needs nothing. */
const GB: Readonly<Record<string, number>> = {
  big: 8,
  mid: 4,
  six: 6,
  five: 5,
  small: 1,
};

const PRIMARY: PlanSelection = { engine: 'llama-vulkan', model: 'small' };

function own(model: string, extra: Partial<PolicySelection> = {}): PolicySelection {
  return { engine: 'llama-vulkan', model, fallback: 'default', ...extra };
}

function flm(model: string): PolicySelection {
  return { engine: 'fastflowlm', model, fallback: 'default' };
}

function keyOf(selection: PlanSelection): string {
  return laneKey(selection.engine, selection.model, selection.device ?? undefined);
}

interface Setup {
  readonly primary?: PlanSelection;
  readonly selections: Record<string, PolicySelection>;
  readonly modes?: Record<string, Mode>;
  readonly loaded?: readonly string[];
  readonly last?: string;
  readonly deps?: Partial<LanePlanDeps>;
}

function plan(setup: Setup): Promise<LanePlan> {
  const deps: LanePlanDeps = {
    check: () => undefined,
    memoryGb: (selection) => GB[selection.model] ?? null,
    isLocal: (selection) => selection.engine !== 'lmstudio',
    resolveDevice: () => undefined,
    budgetGb: BUDGET_GB,
    ...setup.deps,
  };
  const input: LanePlanInput = {
    primary: setup.primary ?? PRIMARY,
    selections: new Map(Object.entries(setup.selections)),
    modes: new Map(Object.entries(setup.modes ?? {})),
    loaded: new Set(setup.loaded ?? []),
    ...(setup.last === undefined ? {} : { last: setup.last }),
  };
  return PolicyEngines.plan(input, deps);
}

describe('PolicyEngines.plan', () => {
  it('makes no lane for an override equal to the primary', async () => {
    const checked: string[] = [];
    const result = await plan({
      selections: { 'command-risk': own('small') },
      deps: { check: (selection) => void checked.push(selection.model) },
    });
    assert.deepEqual(result.start, []);
    assert.deepEqual(result.keep, []);
    assert.equal(result.routes.get('command-risk')?.laneKey, PRIMARY_LANE);
    assert.equal(result.routes.get('command-risk')?.source, 'default');
    assert.equal(result.status.get('command-risk')?.status, 'active');
    assert.deepEqual(checked, []);
  });

  it('treats the resolved device as part of the model, so another device is another lane', async () => {
    const deps = { resolveDevice: (s: PlanSelection) => s.device ?? 'cpu' };
    const result = await plan({
      selections: { a: own('small', { device: 'cuda' }) },
      deps,
    });
    assert.equal(result.routes.get('a')?.laneKey, 'llama-vulkan:small@cuda');
    assert.deepEqual(
      result.start.map((lane) => lane.key),
      ['llama-vulkan:small@cuda'],
    );
  });

  it('shares one lane between policies with the same override', async () => {
    const result = await plan({
      selections: { b: own('mid'), a: own('mid', { fallback: 'open' }) },
    });
    assert.deepEqual(
      result.start.map((lane) => lane.key),
      [keyOf(own('mid'))],
    );
    assert.equal(result.routes.get('a')?.laneKey, keyOf(own('mid')));
    assert.equal(result.routes.get('b')?.laneKey, keyOf(own('mid')));
    assert.equal(result.routes.get('a')?.fallback, 'open');
    assert.equal(result.routes.get('b')?.fallback, 'default');
    assert.equal(result.routes.get('a')?.source, 'policy');
  });

  it('counts a shared lane once against the memory budget', async () => {
    const result = await plan({
      primary: { engine: 'llama-vulkan', model: 'mid' },
      selections: { a: own('five'), b: own('five') },
    });
    assert.equal(result.status.get('a')?.status, 'active');
    assert.equal(result.status.get('b')?.status, 'active');
  });

  it('makes a second fastflowlm model unavailable', async () => {
    const result = await plan({ selections: { a: flm('one'), b: flm('two') } });
    assert.equal(result.status.get('a')?.status, 'active');
    assert.equal(result.status.get('b')?.status, 'unavailable');
    assert.equal(result.status.get('b')?.reason, `${FLM_REASON}; a already uses one`);
    const withPrimary = await plan({
      primary: { engine: 'fastflowlm', model: 'one' },
      selections: { a: flm('two') },
    });
    assert.equal(
      withPrimary.status.get('a')?.reason,
      `${FLM_REASON}; the default model already uses one`,
    );
  });

  it('makes the later policy id unavailable when memory overflows', async () => {
    const overflow = await plan({
      selections: { b: own('six'), a: own('five') },
    });
    assert.equal(overflow.status.get('a')?.status, 'active');
    assert.equal(
      overflow.status.get('b')?.reason,
      'needs ~6 GB with the other models loaded; this machine allows ~10 GB',
    );
    assert.deepEqual(
      overflow.start.map((lane) => lane.key),
      [keyOf(own('five'))],
    );
  });

  it('retires a kept lane that no longer fits a bigger primary', async () => {
    const kept = keyOf(own('mid'));
    const result = await plan({
      primary: { engine: 'llama-vulkan', model: 'big' },
      selections: { 'command-risk': own('mid') },
      loaded: [kept],
    });
    assert.equal(result.status.get('command-risk')?.status, 'unavailable');
    assert.equal(result.status.get('command-risk')?.reason, NO_FIT);
    assert.deepEqual(result.retire, [kept]);
    assert.deepEqual(result.keep, []);
    assert.equal(result.routes.get('command-risk')?.source, 'fallback');
  });

  it('makes a fourth distinct lane unavailable', async () => {
    const selections: Record<string, PolicySelection> = {};
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      selections[id] = own(`model-${String(index)}`);
    }
    const result = await plan({ selections });
    assert.equal(result.start.length, MAX_POLICY_LANES);
    assert.equal(result.status.get('d')?.status, 'unavailable');
    assert.equal(result.status.get('d')?.reason, 'too many decisions with their own model (max 3)');
  });

  it('gives an off policy no lane and no route, but reserves its memory', async () => {
    const result = await plan({
      selections: { a: own('six'), b: own('five') },
      modes: { a: 'off' },
    });
    assert.deepEqual(result.status.get('a'), { status: 'off' });
    assert.equal(result.routes.has('a'), false);
    assert.equal(result.status.get('b')?.status, 'unavailable');
    assert.deepEqual(result.start, []);
  });

  it('does not reserve an off policy twice for one lane, and not at all for the primary', async () => {
    const result = await plan({
      selections: { a: own('five'), b: own('five'), c: own('small') },
      modes: { a: 'off', b: 'shadow', c: 'off' },
    });
    assert.equal(result.status.get('b')?.status, 'active');
    assert.equal(result.status.get('c')?.status, 'off');
  });

  it('answers an unavailable override by the primary on fallback default, and by no model on open', async () => {
    const deps = {
      check: () => {
        throw new Error('nope');
      },
    };
    const result = await plan({
      selections: { a: own('mid'), b: own('mid', { fallback: 'open' }) },
      deps,
    });
    assert.deepEqual(result.routes.get('a'), {
      laneKey: PRIMARY_LANE,
      source: 'fallback',
      fallback: 'default',
      configured: { engine: 'llama-vulkan', model: 'mid' },
      reason: 'nope',
    });
    assert.deepEqual(result.routes.get('b'), {
      laneKey: null,
      source: 'unavailable',
      fallback: 'open',
      configured: { engine: 'llama-vulkan', model: 'mid' },
      reason: 'nope',
    });
  });

  it('changing one override retires only that lane', async () => {
    const [one, two, three] = [own('one'), own('two'), own('three')];
    const result = await plan({
      selections: { a: one, b: three },
      loaded: [keyOf(one), keyOf(two)],
    });
    assert.deepEqual(result.keep, [keyOf(one)]);
    assert.deepEqual(result.retire, [keyOf(two)]);
    assert.deepEqual(
      result.start.map((lane) => lane.key),
      [keyOf(three)],
    );
  });

  it('retires every lane when no override is left, and ignores the primary lane', async () => {
    const result = await plan({
      selections: {},
      loaded: [keyOf(own('one')), PRIMARY_LANE],
    });
    assert.deepEqual(result.retire, [keyOf(own('one'))]);
    assert.equal(result.routes.size, 0);
  });

  it('turns a rejected override into unavailable, never into a throw', async () => {
    const result = await plan({
      selections: { a: own('bad'), b: own('mid') },
      deps: {
        check: (selection) => {
          if (selection.model === 'bad') {
            throw new Error('unknown llama-vulkan model "bad"');
          }
        },
      },
    });
    assert.deepEqual(result.status.get('a'), {
      status: 'unavailable',
      reason: 'unknown llama-vulkan model "bad"',
    });
    assert.equal(result.status.get('b')?.status, 'active');
    assert.deepEqual(
      result.start.map((lane) => lane.key),
      [keyOf(own('mid'))],
    );
  });

  it('awaits an async check and takes a non-Error throw as the reason', async () => {
    const result = await plan({
      selections: { a: own('mid') },
      deps: { check: () => Promise.reject('plain text') },
    });
    assert.equal(result.status.get('a')?.reason, 'plain text');
  });

  it('does not count a remote model against the memory budget', async () => {
    const result = await plan({
      selections: {
        a: { engine: 'lmstudio', model: 'big', fallback: 'default' },
      },
    });
    assert.equal(result.status.get('a')?.status, 'active');
  });
  it('places the candidate last, so a refusal lands on it and not on existing lanes', async () => {
    const selections = {
      a: own('candidate'),
      b: own('model-0'),
      c: own('model-1'),
      d: own('model-2'),
    };
    const byId = await plan({ selections });
    assert.equal(byId.status.get('a')?.status, 'active');
    assert.equal(byId.status.get('d')?.status, 'unavailable');
    const lastPlaced = await plan({
      selections,
      last: 'a',
    });
    assert.equal(lastPlaced.status.get('a')?.status, 'unavailable');
    assert.equal(
      lastPlaced.status.get('a')?.reason,
      'too many decisions with their own model (max 3)',
    );
    for (const id of ['b', 'c', 'd']) {
      assert.equal(lastPlaced.status.get(id)?.status, 'active');
    }
  });

  it('ignores a `last` that is not among the selections', async () => {
    const result = await plan({ selections: { a: own('mid') }, last: 'gone' });
    assert.equal(result.status.get('a')?.status, 'active');
  });

  it('routes a fastflowlm override of the primary model to the primary, whatever the device', async () => {
    const result = await plan({
      primary: { engine: 'fastflowlm', model: 'one' },
      selections: { a: { ...flm('one'), device: 'cpu' } },
      deps: { resolveDevice: (s) => s.device ?? 'npu' },
    });
    assert.equal(result.routes.get('a')?.laneKey, PRIMARY_LANE);
    assert.equal(result.routes.get('a')?.source, 'default');
    assert.equal(result.status.get('a')?.status, 'active');
    assert.deepEqual(result.start, []);
  });

  it('shares one lane between two policies on the same fastflowlm model', async () => {
    const result = await plan({
      selections: { a: flm('one'), b: { ...flm('one'), device: 'cpu' } },
      deps: { resolveDevice: (s) => s.device ?? 'npu' },
    });
    assert.equal(result.start.length, 1);
    assert.equal(result.routes.get('a')?.laneKey, result.routes.get('b')?.laneKey);
    assert.equal(result.status.get('b')?.status, 'active');
  });

  it('reserves nothing for a model of unknown size', async () => {
    const result = await plan({ selections: { a: own('mystery'), b: own('nine') } });
    assert.equal(result.status.get('a')?.status, 'active');
    assert.equal(result.status.get('b')?.status, 'active');
  });

  it('lets the first policy keep a shared lane when the second one is rejected', async () => {
    const result = await plan({
      selections: { a: own('mid'), b: own('mid', { fallback: 'open' }) },
      deps: {
        check: (selection) => {
          if (selection.fallback === 'open') throw new Error('rejected');
        },
      },
    });
    assert.equal(result.status.get('a')?.status, 'active');
    assert.equal(result.routes.get('a')?.laneKey, keyOf(own('mid')));
    assert.equal(result.status.get('b')?.reason, 'rejected');
    assert.equal(result.routes.get('b')?.laneKey, null);
    assert.deepEqual(
      result.start.map((lane) => lane.key),
      [keyOf(own('mid'))],
    );
  });
});
