import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';
import { defaultModelRow, gatewayRow, type DefaultModelRowInput } from '../shared/status-card.ts';

type StatusInput = NonNullable<DefaultModelRowInput['status']>;

const URL = 'http://127.0.0.1:8765';

const status = (extra: Record<string, unknown> = {}): StatusInput => ({
  up: true,
  gatewayUrl: URL,
  p50Ms: null,
  engineState: 'ready',
  detail: null,
  benchmark: null,
  engine: 'fastflowlm',
  engineTag: 'NPU',
  ...extra,
});

function catalog(active: Record<string, unknown> | null = {}): EngineCatalog {
  return parseEngineCatalog({
    active:
      active === null
        ? null
        : {
            engine: 'fastflowlm',
            model: 'd3:nano',
            device: null,
            resolvedDevice: null,
            backend: 'NPU',
            state: 'ready',
            lifecycle: 'lazy',
            ...active,
          },
    engines: [{ id: 'fastflowlm', label: 'FastFlowLM', available: true }],
    models: [
      {
        id: 'd3:nano',
        engine: 'fastflowlm',
        label: 'D3 Nano',
        family: { id: 'f/nano', label: 'd3 nano' },
        format: { short: 'FLM', label: 'NPU (FLM)' },
      },
    ],
  });
}

const NAME = 'd3 nano on NPU · NPU (FLM)';

describe('gatewayRow', () => {
  it('checks before the first answer', () => {
    assert.deepEqual(gatewayRow(undefined), { label: 'Gateway', hint: 'Checking…' });
  });

  it('says where it answers, with the typical decision when known', () => {
    assert.deepEqual(gatewayRow(status()), {
      label: 'Gateway is running',
      hint: `Answering at ${URL}`,
    });
    assert.equal(
      gatewayRow(status({ p50Ms: 850.4 })).hint,
      `Answering at ${URL} · typical decision 850ms`,
    );
  });

  it('says how to start it when it is down', () => {
    const row = gatewayRow(status({ up: false }));
    assert.equal(row.label, 'Gateway is not running');
    assert.equal(
      row.hint,
      `No answer from ${URL}. Start it with: local-decider gateway start (on the computer that runs the Paseo daemon).`,
    );
    assert.equal(row.hint.includes('`'), false);
  });
});

const row = (
  s: Record<string, unknown> | undefined,
  c: EngineCatalog | undefined,
  busy: string | null = null,
): ReturnType<typeof defaultModelRow> =>
  defaultModelRow({ status: s === undefined ? undefined : status(s), catalog: c, busy });

describe('defaultModelRow', () => {
  it('names the model and says it is loaded, with Unload', () => {
    assert.deepEqual(row({}, catalog()), {
      hint: `${NAME}. Loaded.`,
      action: 'unload',
      actionLabel: 'Unload',
      disabled: false,
    });
  });

  it('says a lazy model loads on the next decision and offers Load now', () => {
    const r = row({ engineState: 'stopped' }, catalog({ state: 'stopped' }));
    assert.equal(r.hint, `${NAME}. Not loaded; loads on the next decision.`);
    assert.deepEqual([r.action, r.actionLabel, r.disabled], ['load', 'Load now', false]);
  });

  it('tells an eager model to press Load now', () => {
    const r = row({ engineState: 'stopped' }, catalog({ state: 'stopped', lifecycle: 'eager' }));
    assert.equal(r.hint, `${NAME}. Not loaded; press Load now.`);
  });

  it('shows Loading… and disables the button while it starts or loads', () => {
    const starting = row({ engineState: 'starting' }, catalog({ state: 'starting' }));
    assert.equal(starting.hint, `${NAME}. Loading…`);
    assert.deepEqual([starting.actionLabel, starting.disabled], ['Loading…', true]);
    const busy = row({ engineState: 'stopped' }, catalog({ state: 'stopped' }), 'load');
    assert.deepEqual([busy.actionLabel, busy.disabled], ['Loading…', true]);
  });

  it('shows Unloading… while an unload runs', () => {
    const r = row({}, catalog(), 'unload');
    assert.deepEqual([r.action, r.actionLabel, r.disabled], ['unload', 'Unloading…', true]);
  });

  it('disables the button while any other action runs', () => {
    assert.equal(row({}, catalog(), 'lifecycle').disabled, true);
    assert.equal(row({}, catalog(), 'lifecycle').actionLabel, 'Unload');
  });

  it('keeps the benchmark progress text', () => {
    const r = row({ benchmark: { completed: 3, total: 6 } }, catalog());
    assert.equal(r.hint, `${NAME}. Benchmarking (3 of 6)`);
  });

  it('says a failed engine failed, with why', () => {
    const r = row({ engineState: 'failed', detail: 'NPU busy' }, catalog({ state: 'failed' }));
    assert.equal(r.hint, `${NAME}. Failed: NPU busy.`);
    assert.equal(r.action, 'load');
  });

  it('falls back to the catalog state when health has none', () => {
    assert.equal(row({ engineState: null }, catalog()).hint, `${NAME}. Loaded.`);
  });

  it('says no model is chosen, and cannot load', () => {
    for (const none of [null, { engine: null, model: null }]) {
      const r = row({ engineState: 'stopped' }, catalog(none));
      assert.equal(
        r.hint,
        'None yet. Choose one under Models; until then every decision is skipped.',
      );
      assert.equal(r.disabled, true);
    }
  });

  it('is unknown, and disabled, while the gateway is not running', () => {
    const r = row({ up: false, engineState: null }, catalog());
    assert.equal(r.hint, 'Unknown while the gateway is not running.');
    assert.deepEqual([r.action, r.actionLabel, r.disabled], ['load', 'Load now', true]);
  });

  it('checks while the status or the engines are pending', () => {
    assert.equal(row(undefined, undefined).hint, 'Checking…');
    assert.equal(row({}, undefined).hint, 'Checking…');
    assert.equal(row(undefined, undefined).disabled, true);
  });
});
