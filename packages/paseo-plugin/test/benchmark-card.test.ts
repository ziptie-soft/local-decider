import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { benchmarkCard } from '../shared/benchmark-card.ts';
import { parseBenchmark, type BenchmarkView } from '../shared/benchmark.ts';
import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';

type Obj = Record<string, unknown>;

const NOON = '2026-11-12T12:00:00.000Z';

function measured(p50: number, p95: number, extra: Obj = {}): Obj {
  return {
    device: null,
    typical: { p50Ms: p50, p95Ms: p95 },
    long: { p50Ms: p50 * 3, p95Ms: p50 * 4 },
    sizes: [{ targetTokens: 256, inputTokens: 301, p50Ms: Math.round(p50 / 2), p95Ms: p95 }],
    runs: 5,
    provisional: false,
    measuredAt: NOON,
    freshness: 'fresh',
    staleReason: null,
    failed: null,
    ...extra,
  };
}

function model(
  engine: string,
  id: string,
  family: [string, string],
  format: [string, string] | null,
  m: Obj[],
  extra: Obj = {},
): Obj {
  return {
    id,
    engine,
    label: id,
    installed: true,
    fits: true,
    family: { id: family[0], label: family[1] },
    format: format === null ? null : { short: format[0], label: format[1] },
    measured: m,
    ...extra,
  };
}

const NPU_FORMAT: [string, string] = ['FLM', 'NPU (FLM)'];
const Q4: [string, string] = ['Q4_K_M', '4-bit Q4_K_M'];

function lite(npu: Obj, vulkan: Obj): Obj[] {
  return [
    model('fastflowlm', 'd3:lite', ['f/lite', 'd3 lite'], NPU_FORMAT, [npu]),
    model('llama-vulkan', 'd3-lite-q4', ['f/lite', 'd3 lite'], Q4, [vulkan]),
  ];
}

const MODELS: Obj[] = [
  ...lite(measured(520, 555), measured(460, 1000)),
  model('fastflowlm', 'd3:mini', ['f/mini', 'd3 mini'], NPU_FORMAT, [measured(1687, 1900)]),
  model('llama-vulkan', 'd3-mini-q4', ['f/mini', 'd3 mini'], Q4, [measured(2307, 2500)]),
  model('llama-vulkan', 'd3-mini-q8', ['f/mini', 'd3 mini'], ['Q8_0', '8-bit Q8_0'], []),
  model('fastflowlm', 'd3:nano', ['f/nano', 'd3 nano'], NPU_FORMAT, [measured(760, 800)]),
  model('strands-decider', 'strands-2b', ['s/2b', 'Strands 2B'], null, [
    measured(2400, 2600, { device: 'cpu' }),
    measured(0, 0, {
      device: 'cuda',
      typical: null,
      long: null,
      failed: { error: 'out of memory', at: NOON },
    }),
  ]),
];

const NPU_OPTION = { engine: 'fastflowlm', model: 'd3:lite', device: null, backend: 'NPU' };

function catalog(
  models: Obj[] = MODELS,
  active: Obj = {},
  engines: Record<string, Obj> = {},
): EngineCatalog {
  return parseEngineCatalog({
    active: {
      engine: 'fastflowlm',
      model: 'd3:lite',
      state: 'ready',
      selectionMode: 'auto',
      ...active,
    },
    engines: [
      { id: 'fastflowlm', label: 'FastFlowLM', installed: true, ...engines['fastflowlm'] },
      { id: 'llama-vulkan', label: 'llama.cpp (Vulkan)', installed: true },
      {
        id: 'strands-decider',
        label: 'Strands',
        installed: true,
        devices: ['auto', 'cpu', 'cuda'],
      },
    ],
    models,
    recommendation: {
      candidates: [],
      machine: {
        family: 'f/lite',
        familyLabel: 'd3 lite',
        best: NPU_OPTION,
        runtimes: [
          { engine: 'fastflowlm', device: null, backend: 'NPU', pick: null, variants: [] },
          { engine: 'llama-vulkan', device: null, backend: 'Vulkan', pick: null, variants: [] },
        ],
      },
    },
  });
}

function view(extra: Obj = {}): BenchmarkView {
  const v = parseBenchmark({
    state: 'idle',
    sizes: [256, 1024, 3800],
    runs: 5,
    total: 6,
    completed: 0,
    failed: 0,
    targets: [],
    ...extra,
  });
  assert.ok(v !== null);
  return v;
}

const target = (engine: string, model_: string, state: string, extra: Obj = {}): Obj => ({
  engine,
  model: model_,
  device: null,
  family: null,
  state,
  ...extra,
});

type Card = ReturnType<typeof benchmarkCard>;

function row(card: Card, label: string): Card['rows'][number] {
  const r = card.rows.find((x) => x.label === label);
  assert.ok(r !== undefined, `row ${label}`);
  return r;
}

function cell(card: Card, label: string, column: string): Card['rows'][number]['cells'][number] {
  const c = row(card, label).cells.find((x) => x.column === column);
  assert.ok(c !== undefined, `${label} × ${column}`);
  return c;
}

describe('benchmark card: the table', () => {
  it('lays models out by processor, NPU then GPU then CPU, rows by name', () => {
    const card = benchmarkCard(view(), catalog());
    assert.deepEqual(
      card.columns.map((c) => c.label),
      ['NPU', 'GPU', 'GPU (Vulkan)', 'CPU'],
    );
    assert.deepEqual(
      card.rows.map((r) => r.label),
      ['d3 lite', 'd3 mini', 'd3 nano', 'Strands 2B'],
    );
    assert.ok(card.legend?.startsWith('Median time of one decision'));
  });

  it('shows one number per cell and marks the fastest of a row', () => {
    const card = benchmarkCard(view(), catalog());
    assert.equal(cell(card, 'd3 lite', 'NPU').text, '520 ms');
    assert.equal(cell(card, 'd3 lite', 'GPU (Vulkan)').text, '460 ms');
    assert.equal(cell(card, 'd3 lite', 'GPU (Vulkan)').fastest, true);
    assert.equal(cell(card, 'd3 lite', 'NPU').fastest, false);
    assert.equal(cell(card, 'd3 lite', 'CPU').kind, 'none');
    assert.equal(cell(card, 'd3 lite', 'CPU').text, '—');
    // A single time has nothing to beat.
    assert.equal(cell(card, 'd3 nano', 'NPU').fastest, false);
  });

  it('marks where the running model is in use', () => {
    const card = benchmarkCard(view(), catalog());
    assert.equal(cell(card, 'd3 lite', 'NPU').inUse, true);
    assert.equal(row(card, 'd3 lite').inUse, true);
    assert.equal(row(card, 'd3 mini').inUse, false);
    assert.match(cell(card, 'd3 lite', 'NPU').accessibleName, /^d3 lite on NPU, 520 ms, .*in use/);
  });

  it('names the format only when a model has several on one processor', () => {
    const card = benchmarkCard(view(), catalog());
    assert.equal(cell(card, 'd3 mini', 'GPU (Vulkan)').text, '2.3 s');
    assert.equal(cell(card, 'd3 mini', 'GPU (Vulkan)').format, 'Q4_K_M');
    assert.equal(cell(card, 'd3 lite', 'GPU (Vulkan)').format, null);
  });

  it('keeps an out-of-date time but never calls it the fastest', () => {
    const stale = [
      ...lite(measured(520, 555), measured(300, 320, { freshness: 'stale' })),
      ...MODELS.slice(2),
    ];
    const card = benchmarkCard(view(), catalog(stale));
    const vulkan = cell(card, 'd3 lite', 'GPU (Vulkan)');
    assert.equal(vulkan.stale, true);
    assert.equal(vulkan.fastest, false);
    assert.equal(cell(card, 'd3 lite', 'NPU').fastest, true);
  });

  it('names the GPU runtime the gateway reports', () => {
    const base = catalog();
    const rocm = {
      ...base,
      recommendation:
        base.recommendation === null
          ? null
          : {
              ...base.recommendation,
              candidates: [
                {
                  engine: 'strands-decider',
                  model: 'strands-2b',
                  device: 'cuda',
                  reason: '',
                  backend: 'ROCm',
                  code: 'available' as const,
                  eligible: true,
                  supported: true,
                  ready: true,
                },
              ],
            },
    };
    const card = benchmarkCard(view(), rocm);
    assert.ok(card.columns.some((c) => c.label === 'GPU (ROCm)'));
    assert.equal(cell(card, 'Strands 2B', 'GPU (ROCm)').kind, 'failed');
  });

  it('leaves out models that are not installed', () => {
    const extra = [
      ...MODELS,
      model('fastflowlm', 'd3:big', ['f/big', 'd3 big'], NPU_FORMAT, [], { installed: false }),
    ];
    const card = benchmarkCard(view(), catalog(extra));
    assert.equal(
      card.rows.some((r) => r.label === 'd3 big'),
      false,
    );
  });
});

function withSlowCpu(models: Obj[] = MODELS): EngineCatalog {
  const base = catalog(models);
  const cpu = {
    engine: 'strands-decider',
    model: 'strands-2b',
    device: 'cpu',
    reason: 'CPU: too slow for live decisions',
    backend: 'CPU',
    code: 'too-slow' as const,
    eligible: false,
    supported: true,
    ready: true,
  };
  const rec = base.recommendation;
  assert.ok(rec !== null);
  return { ...base, recommendation: { ...rec, candidates: [cpu] } };
}

describe('benchmark card: the CPU', () => {
  it('tags a measured CPU time background only, never the fastest, and never missing', () => {
    const models = [
      model('strands-decider', 'strands-2b', ['s/2b', 'Strands 2B'], null, [
        measured(5500, 5600, { device: 'cpu' }),
        measured(1400, 1500, { device: 'cuda' }),
      ]),
    ];
    const card = benchmarkCard(view(), withSlowCpu(models));
    const cpu = cell(card, 'Strands 2B', 'CPU');
    assert.equal(cpu.text, '5.5 s');
    assert.equal(cpu.background, true);
    assert.equal(cpu.fastest, false);
    assert.match(cpu.accessibleName, /too slow for live decisions/);
    assert.equal(cell(card, 'Strands 2B', 'GPU').fastest, true);
    assert.ok(card.footer.some((l) => l.startsWith('Background only')));
    // Everything a run would measure is measured, so there is nothing missing to offer.
    assert.deepEqual(card.secondary, []);
  });

  it('leaves out an unmeasured CPU pair, which a run would skip', () => {
    const models = [
      model('strands-decider', 'strands-2b', ['s/2b', 'Strands 2B'], null, [
        measured(1400, 1500, { device: 'cuda' }),
      ]),
    ];
    const card = benchmarkCard(view(), withSlowCpu(models));
    assert.equal(
      card.columns.some((c) => c.label === 'CPU'),
      false,
    );
    assert.deepEqual(card.secondary, []);
  });
});

describe('benchmark card: failures', () => {
  it('lists each failed pair with a Retry that names and targets that pair', () => {
    const card = benchmarkCard(view(), catalog());
    assert.equal(cell(card, 'Strands 2B', 'GPU').text, 'Failed');
    assert.equal(card.problems.length, 1);
    const p = card.problems[0];
    assert.equal(p?.text, 'Strands 2B on GPU: out of memory');
    assert.equal(p?.retry.label, 'Retry Strands 2B on GPU');
    assert.deepEqual(p?.retry.targets, [
      { engine: 'strands-decider', model: 'strands-2b', device: 'cuda' },
    ]);
  });

  it('every Retry targets the model its label names, even with several failures', () => {
    const models = [
      model(
        'llama-vulkan',
        'kev-q8',
        ['j/kev', 'Kev 0.8B'],
        ['Q8_0', '8-bit'],
        [measured(434, 500, { failed: { error: 'engine exited', at: NOON } })],
      ),
      model('llama-vulkan', 'd3-mini-q4', ['f/mini', 'd3 mini'], Q4, [
        measured(1600, 1700, { failed: { error: 'engine exited', at: NOON } }),
      ]),
    ];
    const card = benchmarkCard(view(), catalog(models));
    const byLabel = new Map(card.problems.map((p) => [p.retry.label, p.retry.targets[0]?.model]));
    assert.equal(byLabel.get('Retry Kev 0.8B on GPU (Vulkan)'), 'kev-q8');
    assert.equal(byLabel.get('Retry d3 mini on GPU (Vulkan)'), 'd3-mini-q4');
  });

  it('shows a working variant over a failed one in the same cell, and still lists the failure', () => {
    const models = [
      model('llama-vulkan', 'd3-mini-q4', ['f/mini', 'd3 mini'], Q4, [
        measured(1600, 1700, { failed: { error: 'engine exited', at: NOON } }),
      ]),
      model(
        'llama-vulkan',
        'd3-mini-q8',
        ['f/mini', 'd3 mini'],
        ['Q8_0', '8-bit'],
        [measured(2100, 2200)],
      ),
    ];
    const card = benchmarkCard(view(), catalog(models));
    const c = cell(card, 'd3 mini', 'GPU (Vulkan)');
    assert.equal(c.text, '2.1 s');
    assert.equal(c.format, 'Q8_0');
    assert.equal(card.problems[0]?.retry.label, 'Retry d3 mini Q4_K_M on GPU (Vulkan)');
  });
});

describe('benchmark card: actions', () => {
  it('offers Run again and Measure missing only when some pairs lack a result', () => {
    const card = benchmarkCard(
      view({ preview: { total: 7, etaSeconds: 90, excluded: ['openai-compatible'] } }),
      catalog(),
    );
    assert.equal(card.primary.label, 'Run again');
    assert.deepEqual(
      card.secondary.map((a) => [a.label, a.only]),
      [['Measure missing only', 'missing']],
    );
    assert.equal(card.summary, 'A full run times 7 model–processor pairs · about 2 min.');
    assert.ok(card.footer.includes("Custom servers aren't benchmarked (openai-compatible)."));
  });

  it('says Run benchmark before anything is measured', () => {
    const fresh = [model('fastflowlm', 'd3:nano', ['f/nano', 'd3 nano'], NPU_FORMAT, [])];
    const card = benchmarkCard(
      view({ preview: { total: 1, etaSeconds: 60, excluded: [] } }),
      catalog(fresh),
    );
    assert.equal(card.primary.label, 'Run benchmark');
    assert.deepEqual(card.secondary, []);
    assert.equal(cell(card, 'd3 nano', 'NPU').text, 'Not measured');
  });

  it('cannot run without a benchmark endpoint or anything to measure', () => {
    const gone = benchmarkCard(null, catalog());
    assert.equal(gone.primary.disabled, true);
    const empty = benchmarkCard(
      view({ preview: { total: 0, etaSeconds: 0, excluded: [] } }),
      catalog([]),
    );
    assert.equal(empty.primary.disabled, true);
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.legend, null);
  });

  it('after a cancel, Measure missing only comes first', () => {
    const card = benchmarkCard(
      view({ state: 'cancelled', cancelReason: 'user', total: 3, completed: 1 }),
      catalog(),
    );
    assert.equal(card.primary.label, 'Measure missing only');
    assert.equal(card.secondary[0]?.label, 'Run again');
    assert.match(card.status ?? '', /^Cancelled after 1 of 3\. Finished results are kept\./);
  });
});

function running(): BenchmarkView {
  return view({
    state: 'running',
    phase: 'loading',
    total: 3,
    completed: 1,
    etaSeconds: 70,
    current: { engine: 'llama-vulkan', model: 'd3-mini-q4', device: null, family: 'f/mini' },
    targets: [
      target('fastflowlm', 'd3:nano', 'done', {
        sizes: [{ targetTokens: 1024, inputTokens: 900, p50Ms: 700, p95Ms: 720 }],
      }),
      target('llama-vulkan', 'd3-mini-q4', 'loading'),
      target('fastflowlm', 'd3:mini', 'pending'),
    ],
  });
}

describe('benchmark card: a running job', () => {
  it('shows what loads, how far along it is, and Cancel', () => {
    const card = benchmarkCard(running(), catalog());
    assert.equal(card.stateLabel, 'Running');
    assert.equal(card.activity, 'Loading d3 mini on GPU (Vulkan)…');
    assert.equal(card.progress?.text, '1 of 3 done · about 2 min left');
    assert.equal(card.primary.kind, 'cancel');
    assert.ok(card.note?.startsWith('Decisions are passed to you'));
  });

  it('shows live state in the cells and locks Retry', () => {
    const card = benchmarkCard(running(), catalog());
    assert.equal(cell(card, 'd3 mini', 'GPU (Vulkan)').text, 'Loading…');
    assert.equal(cell(card, 'd3 mini', 'NPU').text, 'Queued');
    assert.equal(cell(card, 'd3 nano', 'NPU').text, '700 ms');
    assert.ok(card.problems.every((p) => p.retry.disabled));
  });

  it('keeps the row order while results come in', () => {
    const before = benchmarkCard(view(), catalog()).rows.map((r) => r.label);
    const during = benchmarkCard(running(), catalog()).rows.map((r) => r.label);
    assert.deepEqual(during, before);
  });

  it('announces only finished pairs', () => {
    assert.equal(benchmarkCard(running(), catalog()).announcement, '1 of 3 done');
  });
});

describe('benchmark card: end states', () => {
  it('reports a finished run, the fastest pair and the restored setup', () => {
    const card = benchmarkCard(
      view({
        state: 'done',
        total: 2,
        completed: 2,
        targets: [
          target('fastflowlm', 'd3:nano', 'done', {
            family: 'f/nano',
            sizes: [{ targetTokens: 1024, inputTokens: 900, p50Ms: 700, p95Ms: 720 }],
          }),
          target('fastflowlm', 'd3:lite', 'done', {
            family: 'f/lite',
            sizes: [{ targetTokens: 1024, inputTokens: 900, p50Ms: 400, p95Ms: 420 }],
          }),
        ],
        restore: { mode: 'auto', engine: 'fastflowlm', model: 'd3:lite', family: 'f/lite' },
        restoredOk: true,
      }),
      catalog(),
    );
    assert.equal(
      card.status,
      'Done: measured 2 pairs. Fastest: d3 lite on NPU, 400 ms. d3 lite on NPU is back in use.',
    );
    // The new time beats the stored one.
    assert.equal(cell(card, 'd3 lite', 'NPU').text, '400 ms');
  });

  it('points to the failures when every pair failed', () => {
    const card = benchmarkCard(
      view({
        state: 'done',
        total: 1,
        completed: 1,
        failed: 1,
        targets: [target('llama-vulkan', 'd3-mini-q4', 'failed', { error: 'engine exited' })],
      }),
      catalog(),
    );
    assert.equal(card.status, 'Done: 1 failed (see Failed below).');
    assert.equal(cell(card, 'd3 mini', 'GPU (Vulkan)').kind, 'failed');
  });

  it('offers to switch back when restoring failed', () => {
    const card = benchmarkCard(
      view({
        state: 'done',
        restore: { mode: 'manual', engine: 'fastflowlm', model: 'd3:lite', family: 'f/lite' },
        restoredOk: false,
        restoreError: 'port busy',
      }),
      catalog(),
    );
    assert.match(
      card.restoreFailure?.text ?? '',
      /^Couldn't switch back to d3 lite on NPU: port busy\./,
    );
    assert.deepEqual(card.restoreFailure?.retry.targets, [
      { engine: 'fastflowlm', model: 'd3:lite', device: null },
    ]);
    assert.equal(card.restoreFailure?.auto.family, 'f/lite');
  });
});
