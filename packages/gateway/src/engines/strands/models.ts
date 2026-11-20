import type { ModelDescriptor } from '../descriptor.ts';

/**
 * `revisions` pins each artifact to a Hugging Face commit (resolved from `main` on 2026-11-20) so
 * installs are reproducible. `strands-decider serve` loads by repo id from the HF cache and its
 * `--revision` flag is v2-only (v1 checkpoints reject it), so it is deliberately not passed.
 * HF_HUB_OFFLINE is not set either: a newer snapshot of the same repo in the user's cache could
 * still be what `refs/main` resolves to.
 */
export const MODELS: readonly ModelDescriptor<'strands-decider'>[] = [
  {
    id: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 2B · Qwen3.5 (reference)',
    downloadGb: 4.8,
    memoryGb: 8,
    gpuMemoryGb: 5,
    latencyHint: '~1.1 s CPU, ~180 ms MPS, ~66 ms MLX (M5 Pro, warm p50, 256-token target)',
    recommended: true,
    quality: { jevBench: 180, brier: 0.28 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    artifacts: ['StrandsAgents/strands-decider-2B-qwen3.5-v1-2610', 'Qwen/Qwen3.5-2B-Base'],
    revisions: {
      'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610':
        '4d27d8d7edcfd6616806c8684e20e2673684e283',
      'Qwen/Qwen3.5-2B-Base': 'b1485b2fa6dfa1287294f269f5fb618e03d52d7c',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-2B-hobson-v21',
    engine: 'strands-decider',
    label: 'Strands 2B · hobson v21',
    downloadGb: 4.6,
    memoryGb: 8,
    gpuMemoryGb: 5,
    latencyHint: '~2.4 s on CPU',
    quality: { jevBench: 176, brier: 0.323 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v21',
    artifacts: ['StrandsAgents/strands-decider-2B-hobson-v21', 'Qwen/Qwen3.5-2B-Base'],
    revisions: {
      'StrandsAgents/strands-decider-2B-hobson-v21': '5c9d44fdeb3bc2de8f0d0340f79b7b801671315b',
      'Qwen/Qwen3.5-2B-Base': 'b1485b2fa6dfa1287294f269f5fb618e03d52d7c',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-2B-hobson-v19',
    engine: 'strands-decider',
    label: 'Strands 2B · hobson v19 (window 3072)',
    downloadGb: 4.6,
    memoryGb: 8,
    gpuMemoryGb: 5,
    latencyHint: '~2.4 s on CPU, 0.15 s on M3 Pro',
    quality: { jevBench: 167, brier: 0.342 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19',
    artifacts: ['StrandsAgents/strands-decider-2B-hobson-v19', 'Qwen/Qwen3.5-2B-Base'],
    revisions: {
      'StrandsAgents/strands-decider-2B-hobson-v19': 'd8b5ad779514179808a8c74213487e3fdd1a07e0',
      'Qwen/Qwen3.5-2B-Base': 'b1485b2fa6dfa1287294f269f5fb618e03d52d7c',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands E2B · Gemma 4',
    downloadGb: 10.6,
    memoryGb: 19,
    gpuMemoryGb: 10,
    latencyHint: '~5 s on CPU, 102 ms on an H100, ~250 ms MLX (M5 Pro, warm p50)',
    quality: { jevBench: 180, brier: 0.313, decisionIndex: 29.78 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
    artifacts: ['StrandsAgents/strands-decider-E2B-gemma4-v1-2610', 'google/gemma-4-E2B-it'],
    revisions: {
      'StrandsAgents/strands-decider-E2B-gemma4-v1-2610':
        '49942ec11bd4678fa916d6b5f1abf460063bc4db',
      'google/gemma-4-E2B-it': '4adf15748de9e1a0097b6274cee9c15836c41c37',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands E4B · Gemma 4',
    downloadGb: 16.5,
    memoryGb: 30,
    gpuMemoryGb: 15,
    latencyHint: '~7 s on CPU, 139 ms on an H100',
    quality: { jevBench: 187, brier: 0.243, decisionIndex: 39.42 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
    artifacts: ['StrandsAgents/strands-decider-E4B-gemma4-v1-2610', 'google/gemma-4-E4B-it'],
    revisions: {
      'StrandsAgents/strands-decider-E4B-gemma4-v1-2610':
        '0fd76a6eac253cbd2cde06015734e987d979e28c',
      'google/gemma-4-E4B-it': '4ecc2ba63bcac23ba4a767fc87025b1450f84c9c',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-12B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 12B · Gemma 4',
    downloadGb: 24.8,
    memoryGb: 46,
    gpuMemoryGb: 23,
    latencyHint: '~14 s on CPU, 136 ms on an H100',
    quality: { jevBench: 200, brier: 0.173, decisionIndex: 47.14 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-12B-gemma4-v1-2610',
    artifacts: ['StrandsAgents/strands-decider-12B-gemma4-v1-2610', 'google/gemma-4-12B-it'],
    revisions: {
      'StrandsAgents/strands-decider-12B-gemma4-v1-2610':
        '56a4eb4361f2ec46867c93d4c73b2d08f8a4ba4a',
      'google/gemma-4-12B-it': '43c9d014b231474fa7212dbb48a762566c2b255d',
    },
  },
  {
    id: 'StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
    engine: 'strands-decider',
    label: 'Strands 26B-A4B · Gemma 4',
    downloadGb: 51.9,
    memoryGb: 101,
    gpuMemoryGb: 51,
    latencyHint: '~8 s on CPU, 245 ms on an H100',
    quality: { jevBench: 207, brier: 0.162, decisionIndex: 48.69 },
    source: 'https://huggingface.co/StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
    artifacts: [
      'StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610',
      'google/gemma-4-26B-A4B-it',
    ],
    revisions: {
      'StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610':
        '1b79a496a6b37e687f9c479bc2f87958c57e501a',
      'google/gemma-4-26B-A4B-it': '4d7ae4984b7db7de8f8457170b3f1a419ee76d52',
    },
  },
];

/** `hf download` argv for a repo, pinned with `--revision` when a commit is known. */
export function hfDownloadArgs(repo: string, revision?: string): string[] {
  return revision === undefined ? ['download', repo] : ['download', repo, '--revision', revision];
}
