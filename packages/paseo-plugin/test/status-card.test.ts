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
      `Answering at ${URL} · typical decision 850 ms`,
    );
    // Not rounded to tens: the popover and the sidebar show the same p50.
    assert.equal(
      gatewayRow(status({ p50Ms: 92.3 })).hint,
      `Answering at ${URL} · typical decision 92 ms`,
    );
    assert.equal(
      gatewayRow(status({ p50Ms: 1500 })).hint,
      `Answering at ${URL} · typical decision 1.5 s`,
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
  catalogFailed = false,
): ReturnType<typeof defaultModelRow> =>
  defaultModelRow({
    status: s === undefined ? undefined : status(s),
    catalog: c,
    catalogFailed,
    busy,
  });

describe('defaultModelRow', () => {
  it('names the model and says it is loaded, with Unload', () => {
    assert.deepEqual(row({}, catalog()), {
      hint: `${NAME}. Loaded.`,
      error: null,
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

  it('offers Cancel loading while it starts, and Loading… while a load request runs', () => {
    const starting = row({ engineState: 'starting' }, catalog({ state: 'starting' }));
    assert.equal(starting.hint, `${NAME}. Loading…`);
    assert.deepEqual(
      [starting.action, starting.actionLabel, starting.disabled],
      ['unload', 'Cancel loading', false],
    );
    const busy = row({ engineState: 'stopped' }, catalog({ state: 'stopped' }), 'load');
    assert.deepEqual([busy.actionLabel, busy.disabled], ['Loading…', true]);
    const cancelling = row({ engineState: 'starting' }, catalog({ state: 'starting' }), 'unload');
    assert.deepEqual([cancelling.actionLabel, cancelling.disabled], ['Unloading…', true]);
  });

  it('shows Unloading… while an unload runs', () => {
    const r = row({}, catalog(), 'unload');
    assert.deepEqual([r.action, r.actionLabel, r.disabled], ['unload', 'Unloading…', true]);
  });

  it('disables the button while any other action runs', () => {
    assert.equal(row({}, catalog(), 'lifecycle').disabled, true);
    assert.equal(row({}, catalog(), 'lifecycle').actionLabel, 'Unload');
  });

  it('says Unload all, and what it also unloads, when a decision has its own model', () => {
    const own = {
      ...catalog(),
      policies: [
        {
          id: 'routing',
          status: 'active' as const,
          selection: { engine: 'fastflowlm', model: 'd3:nano' },
        },
      ],
    } as EngineCatalog;
    const r = row({}, own);
    assert.equal(r.actionLabel, 'Unload all');
    assert.equal(
      r.hint,
      `${NAME}. Loaded. Unload all also unloads the decisions' own models; each loads again on its next decision.`,
    );
    const none = {
      ...own,
      policies: [{ id: 'routing', status: 'default' as const }],
    } as EngineCatalog;
    assert.equal(row({}, none).actionLabel, 'Unload');
  });

  it('keeps the benchmark progress text', () => {
    const r = row({ benchmark: { completed: 3, total: 6 } }, catalog());
    assert.equal(r.hint, `${NAME}. Benchmarking (3 of 6)`);
  });

  it('keeps a failed model name in the hint, why in the error, and Load now as a retry', () => {
    const r = row({ engineState: 'failed', detail: 'NPU busy.' }, catalog({ state: 'failed' }));
    assert.equal(r.hint, 'd3 nano on NPU · NPU (FLM)');
    assert.equal(r.error, 'Failed to load: NPU busy');
    assert.deepEqual([r.action, r.actionLabel, r.disabled], ['load', 'Load now', false]);
    const bare = row({ engineState: 'failed' }, catalog({ state: 'failed' }));
    assert.equal(bare.error, 'Failed to load: no detail from the gateway');
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

  it('says the models are unknown when the engines request failed, not Checking…', () => {
    const r = row({}, undefined, null, true);
    assert.equal(r.hint, 'Unknown: the gateway did not list its models.');
    assert.equal(r.disabled, true);
    const unreachable = row({}, parseEngineCatalog(null));
    assert.equal(unreachable.hint, 'Unknown: the gateway did not list its models.');
  });

  it('checks while the status or the engines are pending', () => {
    assert.equal(row(undefined, undefined).hint, 'Checking…');
    assert.equal(row({}, undefined).hint, 'Checking…');
    assert.equal(row(undefined, undefined).disabled, true);
  });
});
