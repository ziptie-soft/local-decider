import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineLoad, setLifecycle } from '../server/engines.ts';
import {
  engineStateNote,
  engineStateSentence,
  clampIdleMinutes,
  idleHint,
  idleOptions,
  parseIdleMinutes,
  idleValue,
  lifecycleLabel,
  parseIdleValue,
  stateBadge,
} from '../shared/lifecycle.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const base = { detail: null, model: 'd3:nano', engineTag: 'NPU' };

describe('engine state note', () => {
  it('says plainly what the engine is doing', () => {
    assert.equal(engineStateNote({ ...base, state: 'ready' }), 'Loaded · d3:nano · NPU');
    assert.equal(
      engineStateNote({ ...base, state: 'stopped', lifecycle: 'lazy' }),
      'Unloaded · loads automatically on the next decision',
    );
    assert.match(engineStateNote({ ...base, state: 'stopped', lifecycle: 'eager' }), /Load now/);
    assert.equal(engineStateNote({ ...base, state: 'starting' }), 'Loading…');
    assert.equal(
      engineStateNote({ ...base, state: 'failed', detail: 'NPU busy' }),
      'Failed: NPU busy',
    );
    assert.equal(engineStateNote(undefined), 'Engine state unknown');
    assert.equal(engineStateNote({ ...base, state: 'warming' }), 'warming');
    assert.equal(
      engineStateNote({ state: 'ready', detail: null, model: null, engineTag: null }),
      'Loaded',
    );
  });

  it('shows benchmark progress while a run is active, whatever the engine state', () => {
    const benchmark = { completed: 3, total: 6 };
    assert.equal(engineStateNote({ ...base, state: 'ready', benchmark }), 'Benchmarking (3 of 6)');
    assert.equal(
      engineStateNote({ ...base, state: 'starting', benchmark }),
      'Benchmarking (3 of 6)',
    );
    assert.equal(
      engineStateNote({ ...base, state: 'ready', benchmark: null }),
      'Loaded · d3:nano · NPU',
    );
  });
});

describe('state badge', () => {
  it('uses the words of the Status row', () => {
    assert.deepEqual(stateBadge('ready'), { text: 'Loaded', tone: 'success' });
    assert.deepEqual(stateBadge('stopped'), { text: 'Not loaded', tone: 'info' });
    assert.deepEqual(stateBadge('starting'), { text: 'Loading', tone: 'info' });
    assert.deepEqual(stateBadge('failed'), { text: 'Failed', tone: 'error' });
    assert.equal(stateBadge('weird'), null);
    assert.equal(stateBadge(null), null);
  });
});

describe('engine state sentence', () => {
  it('words each state as a sentence', () => {
    assert.equal(engineStateSentence({ ...base, state: 'ready' }), 'Loaded.');
    assert.equal(
      engineStateSentence({ ...base, state: 'stopped', lifecycle: 'lazy' }),
      'Not loaded; loads on the next decision.',
    );
    assert.equal(
      engineStateSentence({ ...base, state: 'stopped' }),
      'Not loaded; loads on the next decision.',
    );
    assert.equal(
      engineStateSentence({ ...base, state: 'stopped', lifecycle: 'eager' }),
      'Not loaded; press Load now.',
    );
    assert.equal(engineStateSentence({ ...base, state: 'starting' }), 'Loading…');
    assert.equal(
      engineStateSentence({ ...base, state: 'failed', detail: 'NPU busy' }),
      'Failed: NPU busy.',
    );
    assert.equal(
      engineStateSentence({ ...base, state: 'failed', detail: 'NPU busy.' }),
      'Failed: NPU busy.',
    );
    assert.equal(
      engineStateSentence({ ...base, state: 'failed' }),
      'Failed: no detail from the gateway.',
    );
    assert.equal(engineStateSentence(undefined), 'State unknown.');
    assert.equal(engineStateSentence({ ...base, state: 'warming' }), 'warming.');
  });

  it('keeps the benchmark progress text, whatever the state', () => {
    const benchmark = { completed: 3, total: 6 };
    assert.equal(
      engineStateSentence({ ...base, state: 'ready', benchmark }),
      'Benchmarking (3 of 6)',
    );
    assert.equal(engineStateSentence({ ...base, state: 'ready', benchmark: null }), 'Loaded.');
  });
});

const labels = (minutes: number | null, lifecycle: 'lazy' | 'eager' = 'lazy'): string[] =>
  idleOptions(lifecycle, minutes).map((o) => o.label);

describe('unload when idle', () => {
  const PRESETS = [
    'After 5 min',
    'After 15 min',
    'After 30 min',
    'After 1 hour',
    'After 4 hours',
    'Never (stay loaded)',
    'Custom…',
  ];

  it('offers the presets, then Never and Custom…', () => {
    assert.deepEqual(labels(15), PRESETS);
    assert.deepEqual(
      idleOptions('lazy', 15).map((o) => o.value),
      ['5', '15', '30', '60', '240', 'never', 'custom'],
    );
  });

  it('inserts a custom idle time in numeric order so it stays selectable', () => {
    assert.deepEqual(labels(20), [
      'After 5 min',
      'After 15 min',
      'After 20 min',
      'After 30 min',
      'After 1 hour',
      'After 4 hours',
      'Never (stay loaded)',
      'Custom…',
    ]);
    assert.equal(labels(1)[0], 'After 1 min');
    assert.equal(labels(1440).at(-3), 'After 1440 min');
    const options = idleOptions('lazy', 20);
    assert.ok(options.some((o) => o.value === idleValue('lazy', 20)));
  });

  it('adds nothing for a lazy engine without a known time or for an eager one', () => {
    assert.deepEqual(labels(null), PRESETS);
    assert.deepEqual(labels(20, 'eager'), PRESETS);
    assert.equal(idleValue('lazy', null), '15');
  });

  it('maps Never to eager and every other value to lazy with its minutes', () => {
    assert.equal(idleValue('eager', 30), 'never');
    assert.equal(idleValue('lazy', 30), '30');
    assert.deepEqual(parseIdleValue('never'), { lifecycle: 'eager' });
    assert.deepEqual(parseIdleValue('60'), { lifecycle: 'lazy', idleUnloadMinutes: 60 });
    assert.deepEqual(parseIdleValue('junk'), { lifecycle: 'lazy', idleUnloadMinutes: 15 });
  });

  it('parses the custom field and clamps it to 1–1440', () => {
    assert.equal(parseIdleMinutes('45'), 45);
    assert.equal(parseIdleMinutes(' 0 '), 1);
    assert.equal(parseIdleMinutes('5000'), 1440);
    assert.equal(parseIdleMinutes(''), null);
    assert.equal(parseIdleMinutes('abc'), null);
  });

  it('keeps idle minutes to whole minutes from 1 to 1440', () => {
    assert.equal(clampIdleMinutes(0), 1);
    assert.equal(clampIdleMinutes(99999), 1440);
    assert.equal(clampIdleMinutes(7.6), 8);
    assert.equal(idleValue('lazy', 5000), '1440');
    assert.equal(labels(5000).at(-3), 'After 1440 min');
    assert.equal(labels(0)[0], 'After 1 min');
    assert.deepEqual(parseIdleValue('9999'), { lifecycle: 'lazy', idleUnloadMinutes: 1440 });
    assert.deepEqual(parseIdleValue('-3'), { lifecycle: 'lazy', idleUnloadMinutes: 1 });
    assert.deepEqual(parseIdleValue('x'), { lifecycle: 'lazy', idleUnloadMinutes: 15 });
  });

  it('explains each choice', () => {
    assert.match(idleHint('lazy'), /^Frees its memory or the NPU when no decision has come/);
    assert.match(idleHint('lazy'), /loads again on the next decision\.$/);
    assert.match(idleHint('eager'), /^Stays loaded, so the first decision is fast/);
  });

  it('labels the lifecycle outcome', () => {
    assert.equal(lifecycleLabel('lazy', 30), 'Automatic: load on demand, unload after 30 min idle');
    assert.match(lifecycleLabel('lazy', null), /15 min/);
    assert.equal(lifecycleLabel('eager', 30), 'Always loaded');
  });
});

describe('load and lifecycle RPCs', () => {
  it('forwards load, unload and lifecycle', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    await engineLoad(d, 'load');
    await engineLoad(d, 'unload');
    await setLifecycle(d, { lifecycle: 'lazy', idleUnloadMinutes: 30 });
    await setLifecycle(d, { lifecycle: 'eager' });
    assert.deepEqual(gw.posts, [
      { name: 'engineLoad', input: 'load' },
      { name: 'engineLoad', input: 'unload' },
      { name: 'setLifecycle', input: { lifecycle: 'lazy', idleUnloadMinutes: 30 } },
      { name: 'setLifecycle', input: { lifecycle: 'eager' } },
    ]);
  });
});
