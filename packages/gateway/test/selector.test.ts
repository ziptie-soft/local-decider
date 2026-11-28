import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostInfo } from '../src/engines/descriptor.ts';
import type { CapabilityResult, HostCapabilities } from '../src/engines/host-capabilities.ts';
import type { Measured } from '../src/engines/ranking.ts';
import { ENGINES } from '../src/engines/registry.ts';
import { rankEngines, type Ranking } from '../src/engines/selector.ts';

const NO: CapabilityResult = { status: 'unavailable', evidence: 'none' };
const MAYBE: CapabilityResult = { status: 'unknown', evidence: 'unknown' };
const YES = (variant?: 'mlx' | 'mps'): CapabilityResult => ({
  status: 'available',
  evidence: 'ok',
  ...(variant === undefined ? {} : { variant }),
});

function caps(over: Partial<HostCapabilities>): HostCapabilities {
  return { npu: NO, nvidia: NO, rocm: NO, apple: NO, vulkan: NO, probedAt: 0, ...over };
}

const LINUX: HostInfo = { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 };
const MAC: HostInfo = { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 64e9 };

function rank(
  host: HostInfo,
  capabilities: HostCapabilities | undefined,
  extra: Partial<Parameters<typeof rankEngines>[0]> = {},
): Ranking {
  return rankEngines({
    host,
    capabilities,
    engines: ENGINES,
    installed: new Set(),
    explicit: null,
    ...extra,
  });
}

function ladder(r: Ranking): string[] {
  return [
    ...new Set(r.candidates.filter((c) => c.eligible).map((c) => `${c.engine}:${c.backend}`)),
  ];
}

/** A fresh, ranked measurement with the given typical p50. */
const timing = (p50Ms: number): Measured => ({
  typical: { p50Ms, p95Ms: p50Ms + 10 },
  long: null,
  runs: 5,
  measuredAt: '2026-11-12T00:00:00.000Z',
  freshness: 'fresh',
  staleReason: null,
  provisional: false,
});

describe('engine ranking', () => {
  it('never offers an MLX candidate for a v2 (transformers) model', () => {
    const family = 'strands-decider:StrandsAgents/strands-decider-E2B-gemma4-v2-2611';
    const r = rank(MAC, caps({ apple: { ...YES('mlx'), mps: true } }), {
      preferredFamily: family,
    });
    const v2 = r.candidates.filter((c) => c.model.includes('-v2-'));
    assert.ok(v2.length > 0);
    assert.ok(v2.every((c) => c.device !== 'mlx'));
    assert.ok(v2.some((c) => c.device === 'mps'));
  });

  it('Linux with an NPU: FLM NPU only; CPU is never automatic', () => {
    const r = rank(LINUX, caps({ npu: YES() }));
    assert.deepEqual(ladder(r), ['fastflowlm:NPU']);
    assert.equal(r.automatic?.engine, 'fastflowlm');
    assert.equal(r.automatic?.model, 'd3:mini');
  });

  it('Linux with NVIDIA: CUDA', () => {
    const r = rank(LINUX, caps({ nvidia: YES() }));
    assert.deepEqual(ladder(r), ['strands-decider:CUDA']);
  });

  it('Linux with ROCm: ROCm (device cuda)', () => {
    const r = rank(LINUX, caps({ rocm: YES() }));
    assert.deepEqual(ladder(r), ['strands-decider:ROCm']);
    assert.equal(r.automatic?.device, 'cuda');
  });

  it('plain Linux, and unknowns, pick nothing: CPU is too slow to choose automatically', () => {
    const plain = rank(LINUX, caps({}));
    assert.deepEqual(ladder(plain), []);
    assert.equal(plain.automatic, null);
    const cpu = plain.candidates.find((c) => c.backend === 'CPU');
    assert.equal(cpu?.supported, true);
    assert.equal(cpu?.code, 'too-slow');
    assert.match(cpu?.reason ?? '', /too slow for live decisions/);
    const unknowns = rank(LINUX, caps({ npu: MAYBE, nvidia: MAYBE, apple: MAYBE }));
    assert.deepEqual(ladder(unknowns), []);
    assert.deepEqual(ladder(rank(LINUX, undefined)), []);
    const npu = unknowns.candidates.find((c) => c.backend === 'NPU');
    assert.match(npu?.reason ?? '', /not confirmed/);
  });

  it('Apple Silicon with MLX: MLX (MPS not confirmed)', () => {
    const r = rank(MAC, caps({ apple: YES('mlx') }));
    assert.deepEqual(ladder(r), ['strands-decider:MLX']);
  });

  it('Apple Silicon with MLX and a confirmed MPS: MLX, MPS', () => {
    const r = rank(MAC, caps({ apple: { ...YES('mlx'), mps: true } }));
    assert.deepEqual(ladder(r), ['strands-decider:MLX', 'strands-decider:MPS']);
  });

  it('flags engines that can never run on this host as unsupported', () => {
    const r = rank(MAC, caps({ apple: YES('mlx') }));
    const flm = r.candidates.find((c) => c.engine === 'fastflowlm');
    assert.equal(flm?.supported, false);
    assert.ok(
      r.candidates
        .filter((c) => !['fastflowlm', 'llama-vulkan'].includes(c.engine))
        .every((c) => c.supported),
    );
    assert.equal(r.candidates.find((c) => c.engine === 'llama-vulkan')?.supported, false);
  });

  it('gives each candidate a stable code', () => {
    const r = rank(MAC, caps({ apple: YES('mlx') }));
    const code = (backend: string): string | undefined =>
      r.candidates.find((c) => c.backend === backend)?.code;
    assert.equal(code('MLX'), 'available');
    assert.equal(code('MPS'), 'not-confirmed');
    assert.equal(code('CPU'), 'too-slow');
    const flm = r.candidates.find((c) => c.engine === 'fastflowlm');
    assert.equal(flm?.code, 'unsupported-platform');
    assert.equal(
      rank(LINUX, caps({})).candidates.find((c) => c.backend === 'NPU')?.code,
      'no-hardware',
    );
  });

  it('explains MPS with MPS evidence, not MLX evidence', () => {
    const r = rank(MAC, caps({ apple: { ...YES('mlx'), mps: true } }));
    const mps = r.candidates.find((c) => c.backend === 'MPS');
    assert.match(mps?.reason ?? '', /MPS/);
    assert.doesNotMatch(mps?.reason ?? '', /MLX/);
  });

  it('Apple Silicon without MLX: MPS', () => {
    const r = rank(MAC, caps({ apple: YES('mps') }));
    assert.deepEqual(ladder(r), ['strands-decider:MPS']);
  });

  it('Linux with a hardware Vulkan GPU: llama Vulkan', () => {
    const r = rank(LINUX, caps({ vulkan: YES() }), { installed: new Set(['llama-vulkan']) });
    assert.deepEqual(ladder(r), ['llama-vulkan:Vulkan']);
    assert.equal(r.automatic?.model, 'd3-mini-q4_k_m');
  });

  it('does not auto-pick llama Vulkan when no server binary or URL is available', () => {
    const r = rank(LINUX, caps({ vulkan: YES() }));
    const llama = r.candidates.find((candidate) => candidate.engine === 'llama-vulkan');
    assert.equal(llama?.ready, false);
    assert.equal(llama?.eligible, false);
    assert.equal(llama?.code, 'not-installed');
    // Nothing else runs fast enough here, so nothing is picked rather than the CPU.
    assert.equal(r.automatic, null);
  });

  it('NPU and Vulkan keeps FLM first', () => {
    assert.deepEqual(
      ladder(
        rank(LINUX, caps({ npu: YES(), vulkan: YES() }), {
          installed: new Set(['llama-vulkan']),
        }),
      ),
      ['fastflowlm:NPU', 'llama-vulkan:Vulkan'],
    );
  });

  it('NVIDIA keeps its model family ahead of a faster-family fallback', () => {
    assert.deepEqual(
      ladder(
        rank(LINUX, caps({ nvidia: YES(), vulkan: YES() }), {
          installed: new Set(['llama-vulkan']),
        }),
      ),
      ['strands-decider:CUDA', 'llama-vulkan:Vulkan'],
    );
  });

  it('Vulkan unknown is not eligible', () => {
    const candidate = rank(LINUX, caps({ vulkan: MAYBE }), {
      installed: new Set(['llama-vulkan']),
    }).candidates.find((c) => c.engine === 'llama-vulkan');
    assert.equal(candidate?.eligible, false);
    assert.equal(candidate?.code, 'not-confirmed');
  });

  it('never recommends uncalibrated engines', () => {
    const r = rank(LINUX, caps({ vulkan: YES() }));
    for (const id of ['lmstudio', 'openai-compatible']) {
      const c = r.candidates.find((x) => x.engine === id);
      assert.equal(c?.eligible, false);
      assert.match(c?.reason ?? '', /uncalibrated/);
    }
  });

  it('explicit selection wins but the list and automatic pick remain', () => {
    const explicit = { engine: 'lmstudio', model: 'qwen', device: null };
    const r = rank(LINUX, caps({ npu: YES() }), { explicit });
    assert.equal(r.recommended?.engine, 'lmstudio');
    assert.equal(r.recommended?.explicit, true);
    assert.equal(r.automatic?.engine, 'fastflowlm');
    assert.ok(r.candidates.length > 2);
  });

  it('rejects a model that does not fit memory instead of substituting', () => {
    const small: HostInfo = { ...LINUX, totalMemoryBytes: 4e9 };
    const r = rank(small, caps({ npu: YES() }));
    assert.deepEqual(ladder(r), []);
    assert.equal(r.automatic, null);
    assert.equal(r.recommended, null);
    const flm = r.candidates.find((c) => c.backend === 'NPU');
    assert.match(flm?.reason ?? '', /does not fit/);
    assert.equal(flm?.model, 'd3:mini');
  });

  it('marks installed engines ready', () => {
    const r = rank(LINUX, caps({}), { installed: new Set(['strands-decider']) });
    assert.equal(r.candidates.find((c) => c.backend === 'CPU')?.ready, true);
  });

  it('uses a known preferred family and ignores an unknown one', () => {
    const preferred = rank(LINUX, caps({ npu: YES() }), {
      preferredFamily: 'vllm-sr/d3-lite',
    });
    assert.equal(preferred.machine?.family, 'vllm-sr/d3-lite');
    assert.equal(preferred.machine?.source, 'preferred');
    const unknown = rank(LINUX, caps({ npu: YES() }), { preferredFamily: 'missing-family' });
    assert.equal(unknown.machine?.family, 'vllm-sr/d3-mini');
    assert.equal(unknown.machine?.source, 'default');
  });

  it('falls back to the ladder when a preferred family is not runnable', () => {
    const result = rank(LINUX, caps({ nvidia: YES() }), { preferredFamily: 'vllm-sr/d3-lite' });
    assert.equal(result.machine?.availability, 'family-unavailable');
    assert.equal(result.automatic?.engine, 'strands-decider');
    assert.equal(result.automatic?.device, 'cuda');
    // With only a CPU, there is nothing to fall back to.
    assert.equal(rank(LINUX, caps({}), { preferredFamily: 'vllm-sr/d3-lite' }).automatic, null);
  });

  it('does not make a machine recommendation for an uncatalogued explicit model', () => {
    const result = rank(LINUX, caps({ npu: YES() }), {
      explicit: { engine: 'lmstudio', model: 'custom-model', device: null },
    });
    assert.equal(result.recommended?.engine, 'lmstudio');
    assert.equal(result.machine, null);
  });

  it('matches an automatic Strands device to the resolved runtime', () => {
    const result = rank(LINUX, caps({ nvidia: YES() }), {
      active: {
        engine: 'strands-decider',
        model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
        device: 'auto',
        resolvedDevice: 'cuda',
      },
    });
    assert.equal(result.machine?.best?.active, true);
    assert.equal(result.machine?.action, 'none');
  });

  it('keeps a hand-picked CPU runtime visible and active, but never as the best', () => {
    const model = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
    const result = rank(LINUX, caps({}), {
      explicit: { engine: 'strands-decider', model, device: 'cpu' },
      active: { engine: 'strands-decider', model, device: 'cpu', resolvedDevice: 'cpu' },
    });
    assert.equal(result.automatic, null);
    assert.equal(result.recommended?.device, 'cpu');
    assert.equal(result.machine?.best ?? null, null);
    const cpu = result.machine?.runtimes.find((r) => r.device === 'cpu');
    assert.equal(cpu?.pick?.active, true);
    assert.equal(cpu?.pick?.code, 'too-slow');
  });

  it('uses fresh measurements and downloaded status to select the best runtime', () => {
    const result = rank(LINUX, caps({ npu: YES(), vulkan: YES() }), {
      installed: new Set(['llama-vulkan']),
      preferredFamily: 'vllm-sr/d3-lite',
      present: new Map([
        ['fastflowlm|d3:lite', true],
        ['llama-vulkan|d3-lite-q8_0', true],
      ]),
      measurements: new Map([
        ['fastflowlm|d3:lite|', { ok: timing(200), failed: null }],
        ['llama-vulkan|d3-lite-q8_0|', { ok: timing(100), failed: null }],
      ]),
    });
    assert.equal(result.machine?.best?.engine, 'llama-vulkan');
    assert.equal(result.automatic?.engine, 'llama-vulkan');
    assert.equal(result.machine?.action, 'use');
  });
});
