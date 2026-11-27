import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelOption } from '../shared/decision-models.ts';
import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';
import {
  holdState,
  modelSelectView,
  optionByValue,
  selectionInput,
  writeModel,
  type ModelRowInputs,
} from '../shared/model-write.ts';
import type { PolicySelectionInput } from '../shared/policies.ts';

type Obj = Record<string, unknown>;

const FRESH = [
  {
    device: null,
    typical: { p50Ms: 400, p95Ms: 800 },
    long: null,
    sizes: [],
    runs: 5,
    provisional: false,
    measuredAt: '2026-11-12T12:00:00.000Z',
    freshness: 'fresh',
    staleReason: null,
    failed: null,
  },
];

function catalogOf(policies: Obj[] | null): EngineCatalog {
  return parseEngineCatalog({
    active: { engine: 'llama-vulkan', model: 'base', device: null, lifecycle: 'lazy' },
    engines: [{ id: 'llama-vulkan', label: 'llama.cpp (Vulkan)', available: true }],
    models: [
      {
        id: 'base',
        engine: 'llama-vulkan',
        label: 'Base',
        installed: true,
        fits: true,
        measured: FRESH,
      },
      {
        id: 'own',
        engine: 'llama-vulkan',
        label: 'Own',
        installed: true,
        fits: true,
        measured: FRESH,
      },
    ],
    ...(policies === null ? {} : { policies }),
  });
}

function inputs(over: Partial<ModelRowInputs> = {}): ModelRowInputs {
  return {
    kind: 'command-risk',
    catalog: catalogOf([]),
    reachable: true,
    mode: 'shadow',
    modesLoaded: true,
    gatewayMode: 'shadow',
    writing: null,
    ...over,
  };
}

function option(value: string, selection?: ModelOption['selection']): ModelOption {
  return {
    label: value,
    detail: '',
    value,
    selection,
    modelLabel: selection === undefined ? null : 'Own',
  };
}

function ownEntry(id: string, extra: Obj = {}): Obj {
  return {
    id,
    selection: { engine: 'llama-vulkan', model: 'own' },
    status: 'active',
    fallback: 'default',
    state: 'ready',
    ...extra,
  };
}

function body(input: PolicySelectionInput): Obj {
  return input.selection;
}

describe('selectionInput', () => {
  it('clears for Default model', () => {
    assert.deepEqual(selectionInput('routing', option('default'), 'default'), {
      policy: 'routing',
      selection: { clear: true },
    });
  });

  it('posts the engine and model with the current fallback, and no device', () => {
    const chosen = option('k', { engine: 'llama-vulkan', model: 'own' });
    assert.deepEqual(body(selectionInput('routing', chosen, 'open')), {
      engine: 'llama-vulkan',
      model: 'own',
      fallback: 'open',
    });
  });

  it('keeps a device unless it is auto', () => {
    const pinned = option('k', { engine: 'e', model: 'm', device: 'npu' });
    assert.equal(body(selectionInput('routing', pinned, 'default'))['device'], 'npu');
    const auto = option('k', { engine: 'e', model: 'm', device: 'auto' });
    assert.equal('device' in body(selectionInput('routing', auto, 'default')), false);
  });
});

describe('modelSelectView', () => {
  it('lists Default model first and shows it selected when the decision has no model', () => {
    const view = modelSelectView(inputs());
    assert.equal(view.value, 'default');
    assert.equal(view.options[0]?.label, 'Default');
    assert.match(view.options[0]?.detail ?? '', /^Base · /);
    assert.equal(view.unsupported, false);
    assert.equal(view.badge, null);
    assert.equal(view.fallback, 'default');
  });

  it('shows the own model and carries its fallback', () => {
    const catalog = catalogOf([ownEntry('command-risk', { fallback: 'open' })]);
    const view = modelSelectView(inputs({ catalog }));
    assert.equal(view.value, 'llama-vulkan|own|auto');
    assert.equal(view.fallback, 'open');
    assert.match(view.line?.text ?? '', /^Own model on /);
    assert.equal(view.line?.tone, 'muted');
  });

  it('shows the model being switched to while a write runs', () => {
    const writing = option('llama-vulkan|own|auto', { engine: 'llama-vulkan', model: 'own' });
    const view = modelSelectView(inputs({ writing }));
    assert.equal(view.value, 'llama-vulkan|own|auto');
    assert.deepEqual(view.line, { text: 'Switching to Own…', tone: 'muted' });
    assert.equal(view.disabled, true);
  });

  it('badges an unavailable model and keeps the option in the list', () => {
    const catalog = catalogOf([
      ownEntry('command-risk', {
        selection: { engine: 'llama-vulkan', model: 'gone' },
        status: 'unavailable',
        reason: 'not installed.',
      }),
    ]);
    const view = modelSelectView(inputs({ catalog }));
    assert.deepEqual(view.badge, { tone: 'warning', text: 'unavailable' });
    assert.ok(optionByValue(view.options, view.value));
  });

  it('is disabled while the engines are pending or the gateway is unreachable', () => {
    const pending = modelSelectView(inputs({ catalog: undefined }));
    assert.equal(pending.line, null);
    assert.equal(pending.disabled, true);
    assert.equal(pending.options.length, 1);
    const down = modelSelectView(inputs({ reachable: false }));
    assert.equal(down.disabled, true);
  });

  it('is unsupported on an older gateway', () => {
    const view = modelSelectView(inputs({ catalog: catalogOf(null) }));
    assert.equal(view.unsupported, true);
    assert.equal(view.line, null);
    assert.equal(view.disabled, true);
  });

  it('is disabled for a policy the gateway has not loaded, not before its modes are known', () => {
    const missing = modelSelectView(inputs({ gatewayMode: undefined }));
    assert.equal(missing.disabled, true);
    assert.equal(missing.line, null);
    assert.equal(
      modelSelectView(inputs({ gatewayMode: undefined, modesLoaded: false })).disabled,
      false,
    );
  });

  it('puts the routing variant text on the Routing card only', () => {
    const catalog = catalogOf([ownEntry('routing-budget', { label: 'Own' })]);
    const routing = modelSelectView(inputs({ kind: 'routing', catalog })).line;
    assert.match(routing?.text ?? '', /^routing-budget has its own model in config\.yaml: Own\./);
    assert.equal(routing?.tone, 'muted');
    assert.equal(modelSelectView(inputs({ catalog })).line, null);
  });
});

describe('a hook kind the gateway has not loaded', () => {
  it('is blocked, like command risk (the Mode line says why)', () => {
    const view = modelSelectView(inputs({ kind: 'permission', gatewayMode: undefined }));
    assert.equal(view.disabled, true);
    assert.equal(view.line, null);
  });
});

describe('holdState', () => {
  it('holds the choice of the card that wrote, and blocks every card, while pending', () => {
    const held = { owner: 'permission', holding: true, busy: null } as const;
    assert.deepEqual(holdState({ ...held, policy: 'permission' }), { mine: true, blocked: true });
    assert.deepEqual(holdState({ ...held, policy: 'routing' }), { mine: false, blocked: true });
  });

  it('keeps holding after the action clears busy, until pending is cleared', () => {
    const refetching = { owner: 'routing', holding: true, busy: null } as const;
    assert.deepEqual(holdState({ ...refetching, policy: 'routing' }), {
      mine: true,
      blocked: true,
    });
    const settled = { owner: 'routing', holding: false, busy: null } as const;
    assert.deepEqual(holdState({ ...settled, policy: 'routing' }), { mine: false, blocked: false });
  });

  it('treats a running action alone as that card writing', () => {
    const running = { owner: null, holding: false, busy: 'command-risk' } as const;
    assert.deepEqual(holdState({ ...running, policy: 'command-risk' }), {
      mine: true,
      blocked: true,
    });
    assert.deepEqual(holdState({ ...running, policy: 'routing' }), { mine: false, blocked: true });
  });

  it('holds nothing with no owner, no pending write and no action', () => {
    const idle = { owner: null, holding: false, busy: null } as const;
    assert.deepEqual(holdState({ ...idle, policy: 'routing' }), { mine: false, blocked: false });
  });
});

describe('optionByValue', () => {
  it('finds an option by its key and nothing else', () => {
    const options = [option('default'), option('a|b|auto')];
    assert.equal(optionByValue(options, 'a|b|auto'), options[1]);
    assert.equal(optionByValue(options, 'x'), undefined);
  });
});

describe('writeModel', () => {
  const chosen = option('k', { engine: 'llama-vulkan', model: 'own' });

  it('posts the input and words a success', async () => {
    let posted: PolicySelectionInput | undefined;
    const outcome = await writeModel(
      (input) => {
        posted = input;
        return Promise.resolve({ ok: true });
      },
      'command-risk',
      chosen,
      'shadow',
      'open',
    );
    assert.deepEqual(posted, {
      policy: 'command-risk',
      selection: { engine: 'llama-vulkan', model: 'own', fallback: 'open' },
    });
    assert.deepEqual(outcome, {
      tone: 'success',
      text: 'Command risk now uses Own. It loads on the first decision.',
    });
  });

  it('words a 200 with an unavailable model as a warning', async () => {
    const outcome = await writeModel(
      () => Promise.resolve({ ok: true, status: 'unavailable', reason: 'No GPU.' }),
      'command-risk',
      chosen,
      'shadow',
      'default',
    );
    assert.equal(outcome.tone, 'warning');
    assert.match(outcome.text, /unavailable: No GPU\. The default model answers instead\./);
  });

  it('words the gateway refusal and a rejected call as errors', async () => {
    const refused = await writeModel(
      () => Promise.resolve({ ok: false, error: 'does not fit' }),
      'command-risk',
      chosen,
      'act',
      'default',
    );
    assert.deepEqual(refused, {
      tone: 'error',
      text: "Couldn't switch Command risk: does not fit.",
    });
    const thrown = await writeModel(
      () => Promise.reject(new Error('boom')),
      'command-risk',
      chosen,
      'act',
      'default',
    );
    assert.match(thrown.text, /the gateway is unreachable/);
  });
});
