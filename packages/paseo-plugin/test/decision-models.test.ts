import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_POLICIES, type GatewayPolicy, type PluginMode } from '../shared/constants.ts';
import { DECISION_KINDS } from '../shared/decision-kinds.ts';
import {
  allModelsTitle,
  defaultModelLabel,
  defaultModelName,
  effectiveP50,
  headerBadge,
  modelNote,
  modelOptions,
  modelOutcome,
  modelRowHint,
  moreModelsCount,
  ownSelection,
  popoverModel,
  popoverModelLabel,
  popoverModelLine,
  popoverRowLabelWith,
  routingVariantHint,
  runningName,
  selectionValue,
  speedHere,
  type ModelHintContext,
} from '../shared/decision-models.ts';
import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';
import type { PolicyEngine, PolicyModel } from '../shared/policy-models.ts';

type Obj = Record<string, unknown>;

const NOON = '2026-11-12T12:00:00.000Z';

function measured(p50: number, extra: Obj = {}): Obj {
  return {
    device: null,
    typical: { p50Ms: p50, p95Ms: p50 * 2 },
    long: null,
    sizes: [],
    runs: 5,
    provisional: false,
    measuredAt: NOON,
    freshness: 'fresh',
    staleReason: null,
    failed: null,
    ...extra,
  };
}

function model(engine: string, id: string, extra: Obj = {}): Obj {
  return { id, engine, label: id, installed: true, fits: true, downloadGb: 2, ...extra };
}

const ENGINES: Obj[] = [
  { id: 'fastflowlm', label: 'FastFlowLM', available: true },
  { id: 'llama-vulkan', label: 'llama.cpp (Vulkan)', available: true },
  { id: 'lmstudio', label: 'LM Studio', available: true, calibrated: false },
  { id: 'strands-decider', label: 'Strands', available: true, devices: ['cpu', 'cuda'] },
  { id: 'ollama', label: 'Ollama', available: false },
];

const MODELS: Obj[] = [
  model('fastflowlm', 'd3:nano', {
    label: 'D3 Nano',
    memoryGb: 1,
    measured: [measured(760)],
    family: { id: 'f/nano', label: 'd3 nano' },
    format: { short: 'FLM', label: 'NPU (FLM)' },
  }),
  model('llama-vulkan', 'slow', { label: 'Slow', memoryGb: 6, measured: [measured(2400)] }),
  model('llama-vulkan', 'fast', { label: 'Fast', memoryGb: 3.5, measured: [measured(460)] }),
  model('llama-vulkan', 'mid', { label: 'Mid', memoryGb: null, measured: [measured(1200)] }),
  model('llama-vulkan', 'edge1000', { label: 'Edge 1000', measured: [measured(1000)] }),
  model('llama-vulkan', 'edge1001', { label: 'Edge 1001', measured: [measured(1001)] }),
  model('llama-vulkan', 'hinted', { label: 'Hinted', latencyHint: '~2 s (Vulkan)' }),
  model('llama-vulkan', 'bare', { label: 'Bare' }),
  model('llama-vulkan', 'stale', {
    label: 'Stale',
    latencyHint: 'quick',
    measured: [measured(100, { freshness: 'stale' })],
  }),
  model('llama-vulkan', 'nofit', { label: 'No fit', fits: false }),
  model('llama-vulkan', 'remote', { label: 'Remote', installed: false, downloadGb: 4 }),
  model('ollama', 'down', { label: 'Down' }),
  model('lmstudio', 'found', { label: 'Found', installed: false, downloadGb: null }),
  model('strands-decider', 'strands', {
    label: 'Strands 2B',
    measured: [measured(2400, { device: 'cpu' }), measured(500, { device: 'cuda' })],
  }),
];

interface World {
  /** `null` is an older gateway: the catalog has no `policies`. */
  policies?: Obj[] | null;
  active?: Obj | null;
  models?: Obj[];
  engines?: Obj[];
}

function world(w: World = {}): EngineCatalog {
  const policies = w.policies === undefined ? [] : w.policies;
  return parseEngineCatalog({
    active:
      w.active === null
        ? null
        : {
            engine: 'fastflowlm',
            model: 'd3:nano',
            device: null,
            resolvedDevice: null,
            backend: 'NPU',
            state: 'ready',
            lifecycle: 'lazy',
            selectionMode: 'manual',
            ...w.active,
          },
    engines: w.engines ?? ENGINES,
    models: w.models ?? MODELS,
    ...(policies === null ? {} : { policies }),
  });
}

/** A policy entry whose own model is `llama-vulkan` `fast` and answers. */
function entry(id: string, extra: Obj = {}): Obj {
  return {
    id,
    selection: { engine: 'llama-vulkan', model: 'fast' },
    status: 'active',
    fallback: 'default',
    engine: 'llama-vulkan',
    model: 'fast',
    label: 'Fast',
    state: 'ready',
    ...extra,
  };
}

function selectionOf(engine: string, id: string, extra: Obj = {}): Obj {
  return { selection: { engine, model: id, ...extra }, engine, model: id };
}

function ctx(over: Partial<ModelHintContext> = {}): ModelHintContext {
  return {
    catalog: world(),
    reachable: true,
    mode: 'shadow',
    policyLoaded: true,
    writing: null,
    ...over,
  };
}

function ctxFor(policy: Obj | null, mode: PluginMode = 'shadow', w: World = {}): ModelHintContext {
  return ctx({ catalog: world({ ...w, policies: policy === null ? [] : [policy] }), mode });
}

function hint(policy: Obj | null, mode: PluginMode = 'shadow', w: World = {}): string {
  return modelRowHint('command-risk', ctxFor(policy, mode, w)).line?.text ?? '';
}

function entryOf(catalog: EngineCatalog, id: string): PolicyModel | undefined {
  return catalog.policies?.find((p) => p.id === id);
}

describe('runningName', () => {
  it('names a known family on its runtime, with its format', () => {
    assert.equal(runningName(world()), 'd3 nano on NPU · NPU (FLM)');
  });

  it('falls back to the engine and model id for an unknown model', () => {
    const catalog = world({ active: { model: 'mystery' } });
    assert.equal(runningName(catalog), 'FastFlowLM · mystery');
  });

  it('names just the engine when no model is reported, and nothing without an engine', () => {
    assert.equal(runningName(world({ active: { model: null } })), 'FastFlowLM');
    assert.equal(runningName(world({ active: null })), null);
    assert.equal(runningName(world({ active: { engine: null } })), null);
  });
});

function byId(id: string): never {
  const found = world().models.find((m) => m.id === id);
  assert.ok(found);
  return found as never;
}

/** `label | detail` per option. */
function pairs(options: { label: string; detail: string }[]): string[] {
  return options.map((o) => `${o.label} | ${o.detail}`);
}

function none(): undefined {
  return undefined;
}

function edge(id: string): string {
  return hint(entry('command-risk', selectionOf('llama-vulkan', id)));
}

function slowBadge(id: string, mode: PluginMode): unknown {
  return headerBadge(
    'command-risk',
    ctxFor(entry('command-risk', selectionOf('llama-vulkan', id)), mode),
  );
}

function live(extra: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    policy: 'command-risk',
    engine: 'llama-vulkan',
    model: 'fast',
    label: 'Fast',
    state: 'ready',
    status: 'active',
    fallback: 'default',
    queueDepth: 0,
    ...extra,
  };
}

function ownDefault(device?: string): Obj {
  return entry(
    'command-risk',
    selectionOf('fastflowlm', 'd3:nano', device === undefined ? {} : { device }),
  );
}

function variantCtx(policies: Obj[], mode: PluginMode = 'shadow'): ModelHintContext {
  return ctx({ catalog: world({ policies }), mode });
}

describe('speedHere', () => {
  it('prints a fresh benchmark as a rounded duration', () => {
    assert.equal(speedHere(byId('d3:nano'), null), '~760 ms in the benchmark');
    assert.equal(speedHere(byId('mid'), null), '~1.2 s in the benchmark');
  });

  it('never uses the catalog latency hint: only a fresh measurement counts', () => {
    assert.equal(speedHere(byId('hinted'), null), 'speed not measured here');
    assert.equal(speedHere(byId('stale'), null), 'speed not measured here');
  });

  it('says not measured with no benchmark at all', () => {
    assert.equal(speedHere(byId('bare'), null), 'speed not measured here');
  });

  it('reads the benchmark of the device the model runs on', () => {
    assert.equal(speedHere(byId('strands'), 'cpu'), '~2.4 s in the benchmark');
    assert.equal(speedHere(byId('strands'), 'cuda'), '~500 ms in the benchmark');
    assert.equal(speedHere(byId('strands'), 'mps'), 'speed not measured here');
  });

  it('gives the range when the device is unknown and several were measured', () => {
    assert.equal(speedHere(byId('strands'), null), '~500 ms to 2.4 s in the benchmark');
  });

  it('uses the only measurement when the device is unknown, never for a named device', () => {
    const solo = model('strands-decider', 'solo', {
      measured: [measured(2400, { device: 'cpu' })],
    });
    const found = world({ models: [solo] }).models[0];
    assert.ok(found);
    assert.equal(speedHere(found, null), '~2.4 s in the benchmark');
    assert.equal(speedHere(found, 'cpu'), '~2.4 s in the benchmark');
    assert.equal(speedHere(found, 'cuda'), 'speed not measured here');
  });
});

describe('effectiveP50', () => {
  it('is the default model’s when the decision has no own model', () => {
    const catalog = world({ policies: [] });
    assert.equal(effectiveP50(catalog, undefined), 760);
    assert.equal(effectiveP50(catalog, { id: 'x', status: 'default' }), 760);
  });

  it('is the own model’s when it answers', () => {
    const catalog = world({ policies: [entry('command-risk')] });
    assert.equal(effectiveP50(catalog, entryOf(catalog, 'command-risk')), 460);
  });

  it('follows the fallback of an unavailable own model', () => {
    const toDefault = world({ policies: [entry('a', { status: 'unavailable' })] });
    assert.equal(effectiveP50(toDefault, entryOf(toDefault, 'a')), 760);
    const open = world({ policies: [entry('a', { status: 'unavailable', fallback: 'open' })] });
    assert.equal(effectiveP50(open, entryOf(open, 'a')), null);
  });

  it('is null for a stale or missing benchmark, and with no default model', () => {
    const stale = world({ policies: [entry('a', selectionOf('llama-vulkan', 'stale'))] });
    assert.equal(effectiveP50(stale, entryOf(stale, 'a')), null);
    assert.equal(effectiveP50(world({ active: null }), undefined), null);
  });
});

describe('modelOptions', () => {
  it('lists Default first, then models by speed, unmeasured last in catalogue order', () => {
    const options = modelOptions('command-risk', world(), none());
    assert.deepEqual(pairs(options), [
      'Default | D3 Nano · NPU · ~760 ms in the benchmark',
      'Fast | GPU (Vulkan) · ~460 ms in the benchmark',
      'D3 Nano | NPU · ~760 ms in the benchmark',
      'Edge 1000 | GPU (Vulkan) · ~1.0 s in the benchmark',
      'Edge 1001 | GPU (Vulkan) · ~1.0 s in the benchmark · too slow for hooks',
      'Mid | GPU (Vulkan) · ~1.2 s in the benchmark · too slow for hooks',
      'Slow | GPU (Vulkan) · ~2.4 s in the benchmark · too slow for hooks',
      // A catalog latency hint is a reference, not a measurement: it is not shown here.
      'Hinted | GPU (Vulkan) · speed not measured here',
      'Bare | GPU (Vulkan) · speed not measured here',
      'Stale | GPU (Vulkan) · speed not measured here',
      'Found | LM Studio · speed not measured here',
      // Several devices on a non-active engine: the catalog cannot say which one `auto` picks,
      // so the option shows the range across them. It still sorts with the unmeasured.
      'Strands 2B | Strands · ~500 ms to 2.4 s in the benchmark',
    ]);
    assert.equal(options[0]?.value, 'default');
    assert.equal(options[1]?.value, 'llama-vulkan|fast|auto');
  });

  it('reads the device of an engine that has just one, and only then', () => {
    const one = world({
      engines: [
        ...ENGINES.filter((e) => e['id'] !== 'strands-decider'),
        {
          id: 'strands-decider',
          label: 'Strands',
          available: true,
          devices: ['cuda'],
        },
      ],
    });
    const option = modelOptions('command-risk', one, none()).find((o) =>
      o.value.startsWith('strands-decider|'),
    );
    assert.equal(option?.detail, 'GPU · ~500 ms in the benchmark');
  });

  it('gives each option the selection it sets and the name of its model', () => {
    const options = modelOptions('command-risk', world(), none());
    assert.equal(options[0]?.selection, undefined);
    assert.equal(options[0]?.modelLabel, null);
    assert.deepEqual(options[1]?.selection, {
      engine: 'llama-vulkan',
      model: 'fast',
      device: undefined,
      fallback: undefined,
    });
    assert.equal(options[1]?.modelLabel, 'Fast');
    for (const option of options.slice(1)) {
      assert.equal(option.value, selectionValue(option.selection));
    }
  });

  it('leaves out models that are not downloaded, do not fit or have no available engine', () => {
    const values = modelOptions('command-risk', world(), none()).map((o) => o.value);
    for (const gone of ['nofit', 'remote', 'down']) {
      assert.ok(!values.some((v) => v.includes(`|${gone}|`)), gone);
    }
    assert.ok(values.includes('lmstudio|found|auto'), 'a discovered model is listed');
  });

  it('marks too slow from 1001 ms on the hooks budget, never at 1000', () => {
    const options = modelOptions('command-risk', world(), none());
    const slow = (id: string): boolean =>
      options
        .find((o) => o.value === `llama-vulkan|${id}|auto`)
        ?.detail.endsWith('too slow for hooks') === true;
    assert.equal(slow('edge1000'), false);
    assert.equal(slow('edge1001'), true);
    assert.equal(DECISION_KINDS['turn-outcome'].budgets.hooks, 1000);
  });

  it('says none yet when there is no default model', () => {
    const options = modelOptions('routing', world({ active: null }), none());
    assert.equal(options[0]?.label, 'Default');
    assert.equal(options[0]?.detail, 'No default model yet');
  });

  it('does not repeat the current override, and reads an unset device as auto', () => {
    const catalog = world({ policies: [entry('a')] });
    const current = ownSelection(entryOf(catalog, 'a'));
    const base = modelOptions('command-risk', catalog, none()).length;
    assert.equal(modelOptions('command-risk', catalog, current).length, base);
    const auto = { engine: 'llama-vulkan', model: 'fast', device: 'auto', fallback: undefined };
    assert.equal(modelOptions('command-risk', catalog, auto).length, base);
  });

  it('appends an override that is no longer listed, with its exact value', () => {
    const catalog = world();
    const gone = {
      engine: 'llama-vulkan',
      model: 'remote',
      device: undefined,
      fallback: undefined,
    };
    const last = modelOptions('command-risk', catalog, gone).at(-1);
    assert.deepEqual(last, {
      label: 'Remote',
      detail: 'unavailable',
      value: 'llama-vulkan|remote|auto',
      selection: gone,
      modelLabel: 'Remote',
    });
    const unknown = {
      engine: 'llama-vulkan',
      model: 'who',
      device: undefined,
      fallback: undefined,
    };
    const lost = modelOptions('command-risk', catalog, unknown).at(-1);
    assert.deepEqual([lost?.label, lost?.detail], ['who', 'unavailable']);
  });

  it('appends a listed model chosen for another device with that device', () => {
    const onCpu = {
      engine: 'strands-decider',
      model: 'strands',
      device: 'cpu',
      fallback: undefined,
    };
    const last = modelOptions('command-risk', world(), onCpu).at(-1);
    assert.deepEqual(last, {
      label: 'Strands 2B',
      detail: 'cpu',
      value: 'strands-decider|strands|cpu',
      selection: onCpu,
      modelLabel: 'Strands 2B',
    });
  });

  it('gives the select value of the current choice', () => {
    assert.equal(selectionValue(undefined), 'default');
    assert.equal(
      selectionValue({ engine: 'a', model: 'b', device: 'cuda', fallback: 'open' }),
      'a|b|cuda',
    );
  });
});

describe('modelRowHint', () => {
  const SLOW = selectionOf('llama-vulkan', 'slow');
  const MID = selectionOf('llama-vulkan', 'mid');

  it('1: shows a write in flight, and disables the select', () => {
    const own = modelRowHint('command-risk', ctx({ writing: { label: 'Fast' } }));
    assert.deepEqual(own, {
      line: { text: 'Switching to Fast…', tone: 'muted' },
      disabled: true,
    });
    const clear = modelRowHint('command-risk', ctx({ writing: { label: null } }));
    assert.equal(clear.line?.text, 'Switching to the default model…');
  });

  it('2: says it cannot change while the gateway is unreachable', () => {
    const row = modelRowHint('command-risk', ctx({ reachable: false }));
    assert.deepEqual(row, { line: null, disabled: true });
    assert.equal(
      modelRowHint('command-risk', ctx({ catalog: parseEngineCatalog(null) })).disabled,
      true,
    );
  });

  it('says nothing, and disables the select, without a catalog, on an older gateway or unloaded', () => {
    const off = { line: null, disabled: true };
    assert.deepEqual(modelRowHint('command-risk', ctx({ catalog: undefined })), off);
    assert.deepEqual(
      modelRowHint('command-risk', ctx({ catalog: world({ policies: null }) })),
      off,
    );
    assert.deepEqual(modelRowHint('command-risk', ctx({ policyLoaded: false })), off);
  });

  it('3: names the reason and the default model answering', () => {
    const row = entry('command-risk', { status: 'unavailable', reason: 'does not fit.' });
    assert.equal(hint(row), 'Unavailable: does not fit. The default model answers instead.');
    assert.equal(modelRowHint('command-risk', ctxFor(row)).line?.tone, 'warning');
  });

  it('3: copes with no reason', () => {
    assert.equal(
      hint(entry('command-risk', { status: 'unavailable' })),
      'Unavailable. The default model answers instead.',
    );
  });

  it('4: names the reason and the skipped decisions', () => {
    const row = entry('command-risk', {
      status: 'unavailable',
      fallback: 'open',
      reason: 'llama-vulkan is not available',
    });
    assert.equal(
      hint(row),
      'Unavailable: llama-vulkan is not available. These decisions are skipped.',
    );
  });

  it('5: says a starting lane skips decisions until ready', () => {
    assert.equal(
      hint(entry('command-risk', { state: 'starting' })),
      'Loading; decisions are skipped until it is ready.',
    );
  });

  it('6: warns of a model too slow for the hooks, in Shadow and Act, but not Off', () => {
    const text = hint(entry('command-risk', SLOW), 'act');
    assert.ok(text.startsWith('Too slow for the hooks: typical 2.4 s against a ~1 s limit, so'));
    assert.equal(hint(entry('command-risk', SLOW), 'shadow'), text);
    assert.notEqual(hint(entry('command-risk', SLOW), 'off'), text);
  });

  for (const kind of GATEWAY_POLICIES) {
    it(`6: ${kind} adds the Paseo sentence only when Paseo's budget covers the model`, () => {
      const paseo = DECISION_KINDS[kind].budgets.paseo;
      const base =
        'Too slow for the hooks: typical {p50} against a ~1 s limit, so Claude Code, Codex and pi skip most of these decisions.';
      const cases: [Obj, string][] = [
        [SLOW, '2.4 s'],
        [MID, '1.2 s'],
      ];
      for (const [selection, p50] of cases) {
        const ms = p50 === '2.4 s' ? 2400 : 1200;
        const text = modelRowHint(kind, ctxFor(entry(kind, selection), 'shadow')).line?.text;
        const expected =
          paseo !== null && ms <= paseo
            ? `${base.replace('{p50}', p50)} Paseo waits up to ${paseoText(paseo)}, so its own requests are answered.`
            : base.replace('{p50}', p50);
        assert.equal(text, expected, `${kind} at ${p50}`);
      }
    });
  }

  it('6: judges the default model too when the decision has none of its own', () => {
    const text = hint(null, 'shadow', { active: { model: 'slow', engine: 'llama-vulkan' } });
    assert.ok(text.startsWith('Too slow for the hooks: typical 2.4 s'));
  });

  it('6: 1000 ms is not too slow and 1001 ms is', () => {
    assert.ok(!edge('edge1000').startsWith('Too slow'));
    assert.ok(edge('edge1001').startsWith('Too slow'));
  });

  it('7: warns of an uncalibrated engine in Act only', () => {
    const lm = entry('command-risk', selectionOf('lmstudio', 'found'));
    const text =
      'Uncalibrated engine: keep this decision in Shadow until its decisions look right.';
    assert.equal(hint(lm, 'act'), text);
    assert.notEqual(hint(lm, 'shadow'), text);
  });

  it('8: says an own model has an unknown speed, and where to measure it', () => {
    for (const id of ['bare', 'stale']) {
      const text = hint(entry('command-risk', selectionOf('llama-vulkan', id)));
      assert.match(text, /^Own model on GPU \(Vulkan\)/);
      assert.ok(text.endsWith(' Speed not measured here.'));
      assert.equal(text.includes('Benchmark'), false);
    }
  });

  it('8: says nothing about speed when the default model answers', () => {
    assert.equal(hint(null, 'shadow', { active: { engine: 'llama-vulkan', model: 'bare' } }), '');
  });

  it('9: says an own model stays unloaded while Mode is Off, only when there is one', () => {
    assert.equal(
      hint(entry('command-risk'), 'off'),
      'Its own model stays unloaded while Mode is Off.',
    );
    assert.equal(
      modelRowHint('command-risk', ctxFor(entry('command-risk'), 'off')).line?.tone,
      'muted',
    );
    assert.equal(hint(null, 'off'), '');
  });

  it('10: notes an own model that equals the default', () => {
    const same = entry('command-risk', selectionOf('fastflowlm', 'd3:nano'));
    const text = 'Same model as the default, but it stays on it if the default changes.';
    assert.equal(hint(same), text);
    const autoDevice = entry(
      'command-risk',
      selectionOf('fastflowlm', 'd3:nano', { device: 'auto' }),
    );
    assert.equal(hint(autoDevice), text);
  });

  it('10: is not the same model on another device than a pinned default model', () => {
    const pinned = { device: 'cpu', resolvedDevice: 'cpu' };
    const same = 'Same model as the default, but it stays on it if the default changes.';
    assert.equal(hint(ownDefault('cpu'), 'shadow', { active: pinned }), same);
    assert.ok(hint(ownDefault(), 'shadow', { active: pinned }).startsWith('Own model on'));
    assert.ok(hint(ownDefault('auto'), 'shadow', { active: pinned }).startsWith('Own model on'));
    assert.ok(hint(ownDefault('cuda'), 'shadow', { active: pinned }).startsWith('Own model on'));
    assert.equal(
      hint(ownDefault('cuda'), 'shadow', { active: { device: 'auto', resolvedDevice: 'cuda' } }),
      same,
    );
  });

  it('11: describes a lazy own model with its memory, in muted text', () => {
    const line = modelRowHint('command-risk', ctxFor(entry('command-risk'))).line;
    assert.equal(
      line?.text,
      'Own model on GPU (Vulkan), about 3.5 GB of extra memory. Loads on its first decision. About 460 ms per decision in the benchmark.',
    );
    assert.equal(line?.tone, 'muted');
  });

  it('11: drops the memory clause when it is unknown', () => {
    const row = entry('command-risk', selectionOf('llama-vulkan', 'edge1000'));
    assert.equal(
      hint(row),
      'Own model on GPU (Vulkan). Loads on its first decision. About 1.0 s per decision in the benchmark.',
    );
  });

  it('12: describes an eager own model', () => {
    const w = { active: { lifecycle: 'eager' } };
    assert.equal(
      hint(entry('command-risk'), 'shadow', w),
      'Own model on GPU (Vulkan), about 3.5 GB of extra memory. Stays loaded. About 460 ms per decision in the benchmark.',
    );
    const row = entry('command-risk', selectionOf('llama-vulkan', 'edge1000'));
    assert.equal(
      hint(row, 'shadow', w),
      'Own model on GPU (Vulkan). Stays loaded. About 1.0 s per decision in the benchmark.',
    );
  });

  it('4: tells where to download a model that is not downloaded', () => {
    const row = {
      ...entry('command-risk'),
      status: 'unavailable',
      reason: 'd3-lite is not downloaded yet.',
    } as const;
    assert.equal(
      hint(row),
      'Unavailable: d3-lite is not downloaded yet. The default model answers instead. Download it under Models.',
    );
  });

  it('13: says nothing when the default model is used', () => {
    assert.equal(modelRowHint('command-risk', ctxFor(null)).line, null);
    assert.equal(hint({ id: 'command-risk', status: 'default' }), '');
  });

  it('does not assume the selection is present when the status is not default', () => {
    assert.equal(hint({ id: 'command-risk', status: 'active' }), '');
  });

  it('takes the first matching row when conditions stack', () => {
    const slowFound = model('lmstudio', 'slowfound', {
      installed: false,
      downloadGb: null,
      measured: [measured(2400)],
    });
    const w = { models: [...MODELS, slowFound] };
    const slowOwn = selectionOf('llama-vulkan', 'slow');
    const starting = entry('command-risk', { ...slowOwn, state: 'starting' });
    const loading = 'Loading; decisions are skipped until it is ready.';
    assert.equal(hint(starting, 'act'), loading, 'loading over too slow');
    const uncalibratedSlow = entry('command-risk', selectionOf('lmstudio', 'slowfound'));
    assert.ok(
      hint(uncalibratedSlow, 'act', w).startsWith('Too slow'),
      'too slow over uncalibrated',
    );
    assert.ok(hint(uncalibratedSlow, 'shadow', w).startsWith('Too slow'), 'too slow in Shadow');
    const unknownOwn = entry('command-risk', selectionOf('lmstudio', 'found'));
    assert.ok(hint(unknownOwn, 'act').startsWith('Uncalibrated'), 'uncalibrated over own');
    assert.ok(hint(unknownOwn, 'shadow').startsWith('Own model on LM Studio'), 'own without Act');
    assert.equal(
      hint(unknownOwn, 'off'),
      'Its own model stays unloaded while Mode is Off.',
      'off over own',
    );
  });

  it('judges the default model for uncalibrated only, and says nothing otherwise', () => {
    const uncalibrated = { active: { engine: 'lmstudio', model: 'found' } };
    assert.ok(hint(null, 'act', uncalibrated).startsWith('Uncalibrated'));
    assert.equal(hint(null, 'shadow', uncalibrated), '');
    assert.equal(hint(null, 'shadow'), '');
  });

  it('puts the problems before the facts about the model', () => {
    const row = entry('command-risk', { ...SLOW, status: 'unavailable', reason: 'gone' });
    assert.ok(hint(row, 'act').startsWith('Unavailable: gone'));
  });
});

function paseoText(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

describe('headerBadge', () => {
  it('is loading while the lane starts, in every mode', () => {
    for (const mode of ['off', 'shadow', 'act'] as const) {
      const c = ctxFor(entry('command-risk', { state: 'starting' }), mode);
      assert.deepEqual(headerBadge('command-risk', c), { tone: 'info', text: 'loading' });
    }
  });

  it('is unavailable for either fallback, in every mode', () => {
    for (const fallback of ['default', 'open']) {
      for (const mode of ['off', 'shadow', 'act'] as const) {
        const c = ctxFor(entry('command-risk', { status: 'unavailable', fallback }), mode);
        assert.deepEqual(headerBadge('command-risk', c), { tone: 'warning', text: 'unavailable' });
      }
    }
  });

  it('is too slow where the hint says so, from 1001 ms', () => {
    assert.deepEqual(slowBadge('slow', 'act'), { tone: 'warning', text: 'too slow' });
    assert.deepEqual(slowBadge('edge1001', 'shadow'), { tone: 'warning', text: 'too slow' });
    assert.equal(slowBadge('edge1000', 'shadow'), null);
    assert.equal(slowBadge('slow', 'off'), null);
  });

  it('shows loading over too slow when both hold', () => {
    const row = entry('command-risk', {
      ...selectionOf('llama-vulkan', 'slow'),
      state: 'starting',
    });
    assert.deepEqual(headerBadge('command-risk', ctxFor(row)), { tone: 'info', text: 'loading' });
  });

  it('is absent for the other rows, and when the select cannot be used', () => {
    assert.equal(headerBadge('command-risk', ctxFor(null)), null);
    assert.equal(headerBadge('command-risk', ctxFor(entry('command-risk'))), null);
    assert.equal(headerBadge('command-risk', ctxFor(entry('command-risk'), 'off')), null);
    assert.equal(headerBadge('command-risk', ctx({ catalog: undefined })), null);
    assert.equal(headerBadge('command-risk', ctx({ catalog: world({ policies: null }) })), null);
    assert.equal(
      headerBadge('command-risk', {
        ...ctxFor(entry('command-risk', { state: 'starting' })),
        reachable: false,
      }),
      null,
    );
  });

  it('reads the entry of its own kind only', () => {
    const c = ctxFor(entry('permission', { state: 'starting' }));
    assert.equal(headerBadge('command-risk', c), null);
    assert.equal(headerBadge('permission', c)?.text, 'loading');
  });
});

describe('modelOutcome', () => {
  const ok = { ok: true } as const;

  it('confirms a model set in Off or Shadow', () => {
    for (const mode of ['off', 'shadow'] as const) {
      assert.deepEqual(modelOutcome('command-risk', 'D3 Lite', mode, ok), {
        tone: 'success',
        text: 'Command risk now uses D3 Lite. It loads on the first decision.',
      });
    }
  });

  it('suggests Shadow after a model set in Act', () => {
    assert.deepEqual(modelOutcome('routing', 'D3 Lite', 'act', ok), {
      tone: 'success',
      text: 'Routing now uses D3 Lite. Thresholds were tuned for the default model: consider Shadow until its decisions look right.',
    });
  });

  it('confirms the default model', () => {
    assert.deepEqual(modelOutcome('turn-outcome', null, 'act', ok), {
      tone: 'success',
      text: 'Turn outcome now uses the default model.',
    });
  });

  it('gives the reason of a failure, however the write failed', () => {
    const refused = { ok: false, error: 'needs ~6 GB with the other models loaded' };
    assert.deepEqual(modelOutcome('permission', 'Big', 'shadow', refused), {
      tone: 'error',
      text: "Couldn't switch Permission: needs ~6 GB with the other models loaded.",
    });
    assert.equal(
      modelOutcome('permission', 'Big', 'shadow', { ok: false, unreachable: true }).text,
      "Couldn't switch Permission: the gateway is unreachable.",
    );
    assert.equal(
      modelOutcome('permission', null, 'shadow', { ok: false }).text,
      "Couldn't switch Permission: the gateway refused without a reason.",
    );
  });

  it('warns when the gateway accepted a model that is not available', () => {
    const res = {
      ok: true,
      status: 'unavailable',
      reason: 'llama-vulkan is not available',
    } as const;
    assert.deepEqual(modelOutcome('command-risk', 'Fast', 'shadow', res), {
      tone: 'warning',
      text: 'Command risk now uses Fast, but it is unavailable: llama-vulkan is not available. The default model answers instead.',
    });
    assert.equal(
      modelOutcome('command-risk', 'Fast', 'shadow', res, 'open').text,
      'Command risk now uses Fast, but it is unavailable: llama-vulkan is not available. These decisions are skipped.',
    );
  });
});

describe('moreModelsCount', () => {
  it('counts models that could be downloaded and run here', () => {
    assert.equal(moreModelsCount(world()), 1);
  });

  it('ignores discovered models, models that do not fit and unavailable engines', () => {
    const models = [
      model('lmstudio', 'found', { installed: false, downloadGb: null }),
      model('llama-vulkan', 'big', { installed: false, fits: false }),
      model('ollama', 'down', { installed: false }),
      model('llama-vulkan', 'have'),
    ];
    assert.equal(moreModelsCount(world({ models })), 0);
  });
});

describe('defaultModelName', () => {
  it('names the running model', () => {
    assert.equal(defaultModelName(world()), 'd3 nano on NPU · NPU (FLM)');
  });

  it('is null when no model is chosen', () => {
    assert.equal(defaultModelName(world({ active: null })), null);
    assert.equal(defaultModelName(world({ active: { engine: null, model: null } })), null);
    assert.equal(defaultModelName(world({ active: { model: null } })), null);
  });
});

describe('allModelsTitle', () => {
  it('counts the models not downloaded yet', () => {
    assert.equal(allModelsTitle(world()), 'All engines and models · 1 not downloaded');
  });

  it('is plain when everything is downloaded', () => {
    const models = [model('llama-vulkan', 'have')];
    assert.equal(allModelsTitle(world({ models })), 'All engines and models');
  });
});

describe('popover model line and label', () => {
  it('shows an own model that is ready', () => {
    assert.deepEqual(popoverModelLine(live()), { text: 'Own model: Fast', tone: 'muted' });
    assert.equal(popoverModelLabel(live()), 'Own model: Fast.');
  });

  it('falls back to the model id, then to no name', () => {
    assert.equal(popoverModelLine(live({ label: undefined }))?.text, 'Own model: fast');
    const bare = live({ label: undefined, model: undefined });
    assert.equal(popoverModelLine(bare)?.text, 'Own model');
    assert.equal(popoverModelLabel(bare), 'Own model.');
  });

  it('shows an own model that is loading', () => {
    assert.deepEqual(popoverModelLine(live({ state: 'starting' })), {
      text: 'Own model loading…',
      tone: 'muted',
    });
    assert.equal(popoverModelLabel(live({ state: 'starting' })), 'Own model loading.');
  });

  it('warns of an own model that is unavailable, by fallback', () => {
    const toDefault = live({ status: 'unavailable', fallback: 'default' });
    assert.deepEqual(popoverModelLine(toDefault), {
      text: 'Own model unavailable · using default',
      tone: 'warning',
    });
    assert.equal(popoverModelLabel(toDefault), 'Own model unavailable, using default.');
    const open = live({ status: 'unavailable', fallback: 'open' });
    assert.deepEqual(popoverModelLine(open), {
      text: 'Own model unavailable · skipped',
      tone: 'warning',
    });
    assert.equal(popoverModelLabel(open), 'Own model unavailable, decisions skipped.');
    assert.equal(
      popoverModelLine(live({ status: 'unavailable', fallback: undefined }))?.tone,
      'warning',
    );
  });

  it('warns of an own model that failed, by fallback', () => {
    const toDefault = live({ state: 'failed', fallback: 'default' });
    assert.deepEqual(popoverModelLine(toDefault), {
      text: 'Own model failed · using default',
      tone: 'warning',
    });
    assert.equal(popoverModelLabel(toDefault), 'Own model failed, using default.');
    const open = live({ state: 'failed', fallback: 'open' });
    assert.deepEqual(popoverModelLine(open), {
      text: 'Own model failed · skipped',
      tone: 'warning',
    });
    assert.equal(popoverModelLabel(open), 'Own model failed, decisions skipped.');
    assert.equal(popoverModelLine(live({ state: 'failed', fallback: undefined }))?.tone, 'warning');
  });

  it('shows a lazy model that has not loaded yet as an ordinary own model', () => {
    assert.deepEqual(popoverModelLine(live({ state: 'stopped' })), {
      text: 'Own model: Fast',
      tone: 'muted',
    });
    assert.equal(popoverModelLabel(live({ state: 'stopped' })), 'Own model: Fast.');
  });

  it('has nothing to say for the default model, an off decision, or no entry', () => {
    for (const entryOrNone of [
      live({ status: 'default' }),
      live({ status: 'off' }),
      live({ status: undefined }),
      undefined,
    ]) {
      assert.equal(popoverModelLine(entryOrNone), null);
      assert.equal(popoverModelLabel(entryOrNone), null);
    }
  });
});

describe('routingVariantHint', () => {
  const VARIANT = entry('routing-budget', selectionOf('llama-vulkan', 'fast'));
  const text =
    'routing-budget has its own model in config.yaml: Fast. This choice applies to the other routing policies.';

  it('names the variant and its model when the base decision has none or its own', () => {
    assert.equal(routingVariantHint(variantCtx([VARIANT])), text);
    assert.equal(routingVariantHint(variantCtx([entry('routing'), VARIANT])), text);
    const eager = ctx({ catalog: world({ policies: [VARIANT], active: { lifecycle: 'eager' } }) });
    assert.equal(routingVariantHint(eager), text);
  });

  it('uses the model id when it is unknown', () => {
    const odd = entry('routing-task-kind', {
      ...selectionOf('llama-vulkan', 'who'),
      label: undefined,
    });
    assert.ok(routingVariantHint(variantCtx([odd]))?.includes('config.yaml: who.'));
  });

  it('is null without a variant of its own model, and for another policy', () => {
    assert.equal(routingVariantHint(variantCtx([])), null);
    assert.equal(
      routingVariantHint(variantCtx([{ id: 'routing-budget', status: 'default' }])),
      null,
    );
    assert.equal(routingVariantHint(variantCtx([entry('command-risk')])), null);
    assert.equal(routingVariantHint(variantCtx([entry('routing')])), null);
  });

  it('leaves the rows that come before row 11 to say their own thing', () => {
    assert.equal(routingVariantHint(variantCtx([VARIANT], 'off')), null);
    const starting = entry('routing', { state: 'starting' });
    assert.equal(routingVariantHint(variantCtx([starting, VARIANT])), null);
    assert.equal(routingVariantHint(ctx({ catalog: undefined })), null);
    assert.equal(routingVariantHint(ctx({ writing: { label: null } })), null);
  });
});

describe('hint and policy kinds', () => {
  it('covers every decision kind', () => {
    const kinds: GatewayPolicy[] = [...GATEWAY_POLICIES];
    for (const kind of kinds) {
      const row = modelRowHint(kind, ctxFor(null));
      assert.equal(row.line, null);
      assert.equal(row.disabled, false);
    }
  });
});

describe('popoverModel', () => {
  const engines = [live(), live({ policy: 'permission', state: 'failed', fallback: 'open' })];

  it('reads the entry of the decision', () => {
    assert.deepEqual(popoverModel(engines, 'command-risk'), {
      line: { text: 'Own model: Fast', tone: 'muted' },
      sentence: 'Own model: Fast.',
    });
    assert.equal(popoverModel(engines, 'permission').line?.tone, 'warning');
  });

  it('words both failed lines and their label sentences', () => {
    const toDefault = popoverModel(
      [live({ state: 'failed', fallback: 'default' })],
      'command-risk',
    );
    assert.deepEqual(toDefault, {
      line: { text: 'Own model failed · using default', tone: 'warning' },
      sentence: 'Own model failed, using default.',
    });
    const open = popoverModel(engines, 'permission');
    assert.deepEqual(open, {
      line: { text: 'Own model failed · skipped', tone: 'warning' },
      sentence: 'Own model failed, decisions skipped.',
    });
  });

  it('shows a lazy model that has not loaded yet like a ready one', () => {
    assert.deepEqual(popoverModel([live({ state: 'stopped' })], 'command-risk'), {
      line: { text: 'Own model: Fast', tone: 'muted' },
      sentence: 'Own model: Fast.',
    });
  });

  it('does not show a variant with its own model on the row of its policy', () => {
    const variant = [live({ policy: 'routing-budget' })];
    assert.deepEqual(popoverModel(variant, 'routing'), { line: null, sentence: null });
  });

  it('gives every gateway policy with an entry a line', () => {
    for (const policy of GATEWAY_POLICIES) {
      const row = popoverModel([live({ policy })], policy);
      assert.equal(row.line?.text, 'Own model: Fast', policy);
      assert.equal(row.sentence, 'Own model: Fast.', policy);
    }
  });

  it('says nothing for a decision on the default row or from an older gateway', () => {
    const silent = { line: null, sentence: null };
    assert.deepEqual(popoverModel(engines, 'routing'), silent);
    assert.deepEqual(popoverModel([], 'command-risk'), silent);
    assert.deepEqual(popoverModel(undefined, 'command-risk'), silent);
  });

  it('appends the sentence to the row label', () => {
    assert.equal(
      popoverRowLabelWith('Command risk: Act.', popoverModel(engines, 'command-risk')),
      'Command risk: Act. Own model: Fast.',
    );
    assert.equal(
      popoverRowLabelWith('Routing: Off.', popoverModel(engines, 'routing')),
      'Routing: Off.',
    );
  });
});

describe('modelNote', () => {
  it('names the default model by its catalog label', () => {
    const catalog = world();
    assert.equal(defaultModelLabel(catalog), 'D3 Nano');
    assert.equal(
      modelNote(catalog),
      'Default: D3 Nano. A decision with its own model loads it next to the default and needs extra memory; at most 3 at once.',
    );
  });

  it('falls back to a generic lead without a default model', () => {
    const catalog = world({ active: { model: null } });
    assert.equal(defaultModelLabel(catalog), null);
    assert.ok(modelNote(catalog).startsWith('Default: the default model.'));
    assert.ok(modelNote(undefined).startsWith('Default: the default model.'));
  });
});
