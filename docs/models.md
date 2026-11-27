# Models

A decider model reads a short state (a command, a permission request, a task, a turn transcript)
and answers a few questions with probabilities. The gateway turns those probabilities into an
action with the policy's thresholds ([policies.md](policies.md)). It is a small model that decides;
it does not write text.

The runtimes that load the models (Strands Decider, FastFlowLM, llama.cpp, OpenAI-compatible
servers) are in [engines.md](engines.md). This page is about the models: what each one is, what it
costs, what it is good at, and what we recommend. Every number comes from one machine, an AMD Ryzen
AI 9 365 with a Radeon 880M and an XDNA2 NPU, and from the fixture eval; yours will differ.
[benchmarks.md](benchmarks.md) has the method, and `local-decider bench` measures your own machine.

Last checked: 2026-11-27.

## 1. Models

One row per model in the gateway's catalogue, plus the model LM Studio ships in the catalogue.
Servers you point `openai-compatible` or `lmstudio` at report their own models, so those are not
listed. Size is the download, then the memory the model needs (host memory, or GPU memory in
brackets where it differs). Latency is the p50 of a 256-token state with the hardware and date; a
model nobody measured here reads "unmeasured". The hardware column says where the model runs.

| id | Engine | Family | Size (download / memory) | Quant | Hardware | Typical latency | Calibrated |
|---|---|---|---|---|---|---|---|
| `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` | `strands-decider` | Strands | 4.8 GB / 8 GB (5 GB) | – | CPU, CUDA, ROCm, MLX, MPS | CPU 2.4 s (Ryzen AI 9 365, 2026-11-10); ROCm 0.6 s (Radeon 880M, 2026-11-12) | yes |
| `StrandsAgents/strands-decider-2B-hobson-v21` | `strands-decider` | Strands | 4.6 GB / 8 GB (5 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-2B-hobson-v19` | `strands-decider` | Strands | 4.6 GB / 8 GB (5 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-E2B-gemma4-v1-2610` | `strands-decider` | Strands | 10.6 GB / 19 GB (10 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-E4B-gemma4-v1-2610` | `strands-decider` | Strands | 16.5 GB / 30 GB (15 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-12B-gemma4-v1-2610` | `strands-decider` | Strands | 24.8 GB / 46 GB (23 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610` | `strands-decider` | Strands | 51.9 GB / 101 GB (51 GB) | – | CPU, CUDA, ROCm, MLX, MPS | unmeasured | yes |
| `StrandsAgents/strands-decider-E2B-gemma4-v2-2611` | `strands-decider` | Strands | 10.3 GB / 22 GB (24 GB) | – | CPU, CUDA, ROCm, MPS (no MLX) | unmeasured | yes |
| `d3:edge` | `fastflowlm` | d3 edge | 0.6 GB / 2 GB | FLM | AMD XDNA2 NPU, Linux | unmeasured | yes |
| `d3:lite` | `fastflowlm` | d3 lite | 0.8 GB / 3 GB | FLM | AMD XDNA2 NPU, Linux | 228 ms (NPU, 2026-11-10) | yes |
| `d3:nano` | `fastflowlm` | d3 nano | 2 GB / 5 GB | FLM | AMD XDNA2 NPU, Linux | 325 ms (NPU, 2026-11-10) | yes |
| `d3:mini` | `fastflowlm` | d3 mini | 3.4 GB / 9 GB | FLM | AMD XDNA2 NPU, Linux | 721 ms (NPU, 2026-11-12) | yes |
| `d3:flash` | `fastflowlm` | d3 flash | 6.1 GB / 14 GB | FLM | AMD XDNA2 NPU, Linux | unmeasured | yes |
| `d3:turbo` | `fastflowlm` | d3 turbo | 16.6 GB / 28 GB | FLM | AMD XDNA2 NPU, Linux | unmeasured | yes |
| `d3:ultra` | `fastflowlm` | d3 ultra | 16.6 GB / 28 GB | FLM | AMD XDNA2 NPU, Linux | unmeasured | yes |
| `d3-mini-q4_k_m` | `llama-vulkan` | d3 mini | 3.7 GB / 5 GB | Q4_K_M | Vulkan GPU; CPU with `gpuLayers: 0` | 817 ms (Radeon 880M, 2026-11-12) | yes |
| `d3-mini-q8_0` | `llama-vulkan` | d3 mini | 5.2 GB / 6.5 GB | Q8_0 | Vulkan GPU; CPU with `gpuLayers: 0` | 701 ms (Radeon 880M, 2026-11-12) | yes |
| `d3-nano-q8_0` | `llama-vulkan` | d3 nano | 2.6 GB / 3.5 GB | Q8_0 | Vulkan GPU; CPU with `gpuLayers: 0` | unmeasured | yes |
| `d3-lite-q8_0` | `llama-vulkan` | d3 lite | 1.1 GB / 2 GB | Q8_0 | Vulkan GPU; CPU with `gpuLayers: 0` | 141–184 ms (Radeon 880M, 2026-11-12) | yes |
| `d3-flash-q4_k_m` | `llama-vulkan` | d3 flash | 6.6 GB / 8 GB | Q4_K_M | Vulkan GPU; CPU with `gpuLayers: 0` | unmeasured | yes |
| `kev-0.8b-q8_0` | `llama-vulkan` | Kev | 0.8 GB / 1.5 GB | Q8_0 | Vulkan GPU; CPU with `gpuLayers: 0` | 156 ms (Radeon 880M, 2026-11-27) | yes |
| `qwen3-4b-instruct-2507` | `lmstudio` | LM Studio | not reported | GGUF Q4_K_M | wherever LM Studio runs | unmeasured | **no** |

Notes:

- The `d3-lite-q8_0` range comes from interleaved runs under the same load.
- The Strands 2B memory is for the CPU; on a GPU it needs the figure in brackets.
- The memory of `kev-0.8b-q8_0` is the 0.81 GB file plus the KV cache at a 4,096-token context.
  The 312 MB the `llama-server` process showed on Vulkan undercounts it, because the weights sit in
  GPU-mapped memory.
- A model that does not fit in 80% of the machine's memory is listed but cannot be selected
  ([engines.md](engines.md#4-adding-a-model)).
- "Calibrated" means the probabilities were checked against the policy thresholds. The d3 and
  Strands rows are calibrated models, but "calibrated" is not "passes the gate": see section 3.

## 2. Capabilities and limits

**Strands.** The `strands-decider` engine runs the Strands Decider checkpoints through PyTorch or
MLX. The 2B Qwen3.5 checkpoint is the reference: the one the fixture recordings, the CI gate and
`mise run eval:record` use. The other checkpoints are catalogued, but nothing here measured them.
A 2B state window is 4,096 tokens including the question, so a policy must keep its state below
that (the default policies do, at 1,000 to 3,000 tokens). The E2B v2
checkpoint uses the transformers backend: it cannot run on MLX, and it is not recommended by
default. On CPU the 2B takes about 2 s plus 5.5 ms per token, which is above the 1 s hook budget,
so on CPU it is a shadow and background decider ([benchmarks.md](benchmarks.md#strands-2b-on-cpu)).
On the Radeon 880M with ROCm it is about four times faster than on the CPU.

**d3.** d3 is a family of decision models in several sizes (edge, lite, nano, mini, flash, turbo
and ultra). FastFlowLM runs them on the AMD XDNA2 NPU, and llama.cpp runs GGUF builds
of lite, nano, mini and flash on a Vulkan GPU. The same size on two runtimes is one family, so the
gateway can rank the runtimes against each other on your machine, and it never switches family on
its own ([engines.md](engines.md#5b-model-families-and-the-recommendation)). FastFlowLM serves one
decision model per NPU server, so the gateway runs one d3 size on the NPU at a time. d3:mini is
the catalogue's recommended d3 model and d3:nano the fast one. On Vulkan, `d3-mini-q8_0` is about
11–14% faster than `d3-mini-q4_k_m`, and `d3-lite-q8_0` is the quickest model measured here on a
short state (141–184 ms). llama.cpp needs `b11572` or newer, compiled with Vulkan. The gateway also
runs these GGUFs on the CPU with `gpuLayers: 0`
([engines.md](engines.md#cpu-set-enginesllama-vulkangpulayers-0)).

**Kev.** `kev-0.8b-q8_0` is Kev 0.8B (`ggml-org/Kev-0.8B-GGUF`, from `jaredpalmer/kev-0.8b`) on the
llama.cpp engine. Upstream validated only one use of it: a single yes/no question, "is this
command risky?", the `noul` shape the `command-risk-binary` policy asks (below). Our default
policies ask multi-option questions, and on those Kev's probabilities are close to flat, so its
answers fall below the policy thresholds and the policy default or `ask` wins. It fails the eval
gate on all six default policies, so it is in the catalogue as `recommended: false` and is not
recommended for any decision kind ([benchmarks.md](benchmarks.md#kev-08b-on-llamacpp-vulkan) has
the per-class numbers). It is fast: 156 ms p50 at 256 tokens and 435 ms at 1,024 on the Radeon 880M,
against 135 ms and 352 ms for `d3-lite-q8_0`. It has not been measured on `command-risk-binary`.
Select it by hand with `local-decider engine use llama-vulkan kev-0.8b-q8_0`.

**Discovered OpenAI-compatible and LM Studio models.** `openai-compatible` and `lmstudio` score one
option token from the server's logprobs, so the numbers are a general-purpose model's next-token
distribution, not a tuned decision head. They are uncalibrated: start in `shadow` mode, read
`local-decider stats`, and set thresholds from your own data. They are never chosen automatically,
and they have no family. LM Studio returns usable logprobs only from the GGUF build of
`qwen3-4b-instruct-2507` among the models tried ([engines.md](engines.md#6-openai-compatible-prompt-mapping-and-caveats)).

## 3. Which decision kinds each model suits

A model suits a decision kind when the live eval for that policy
(`mise run eval -- --policy <id>`) passes the per-class floors in `policies/fixtures/gate.json`
([policies.md](policies.md#fixtures-and-the-ci-gate)). Each cell says what the evidence is, and
there is no cell that rests on speed alone. "Passes the gate" for Strands is the reference
recordings the CI gate replays; for Kev it is `mise run eval` against a live gateway.

| Family | `command-risk` | `permission` | `routing` | `turn-outcome` | `command-risk-binary` |
|---|---|---|---|---|---|
| Strands 2B Qwen3.5 (reference) | passes the gate (recorded fixtures) | passes the gate (recorded fixtures) | passes the gate (recorded fixtures) | passes the gate (recorded fixtures) | passes the gate (recorded fixtures) |
| Other Strands checkpoints | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| d3 (FastFlowLM and llama.cpp) | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| Kev 0.8B | below the gate (benchmarks.md) | below the gate (benchmarks.md) | below the gate (benchmarks.md) | below the gate (benchmarks.md) | unmeasured |
| Discovered OpenAI-compatible and LM Studio models | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

The reference also passes the gate on the two routing variants, `routing-budget` and
`routing-task-kind`. Kev fails both ([benchmarks.md](benchmarks.md#kev-08b-on-llamacpp-vulkan)).
An integration run saw d3:mini answer six hand-picked cases correctly, but no fixture backs it, so
the d3 cells stay "unmeasured" until `mise run eval` has scored them.

**`command-risk-binary`** is an opt-in variant of `command-risk` with one yes/no question, "is
running this command risky?", the shape small decision models such as Kev are validated on. Select
it with `local-decider policies use command-risk command-risk-binary`; adapters keep asking for
`command-risk`. It asks when the probability of "risky" is at least 0.2, logs when the model is at
least 80% sure the command is not risky, and asks for everything else. **It has no `deny` rule: it
never blocks.** Deterministic deny rules stay the only blocker. On the reference Strands 2B it
scores `true` 28/30 and `false` 11/14, against gate floors of 0.8 and 0.7.

## 4. Recommended defaults

Only a model that passes the gate for a decision kind is recommended for it, so the only model
recommended for every kind is the Strands 2B reference
(`StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`). Automatic selection (`selection.mode: auto`)
ranks by hardware instead, and it only picks calibrated engines. This is what `rankEngines` gives:

| Hardware class | Automatic pick | Gate evidence |
|---|---|---|
| AMD XDNA2 NPU (Linux) | `fastflowlm` `d3:mini` | unmeasured |
| NVIDIA CUDA or AMD ROCm | `strands-decider` 2B reference on the GPU | passes the gate |
| Vulkan GPU | `llama-vulkan` `d3-mini-q4_k_m` | unmeasured |
| Apple Silicon (MLX or MPS) | `strands-decider` 2B reference | passes the gate |
| CPU only | `strands-decider` 2B reference | passes the gate |

The ladder tries them in that order, then ranks the runtimes of the picked family by your own
benchmark. Treat a "passes the gate" pick as the recommendation and an "unmeasured" pick as the
catalogue's default: run `mise run eval` before you let a policy `act` on it. Kev is never picked
automatically.

**Budgets.** A caller passes a timeout and the gateway decides within that minus 500 ms:

| Caller | Budget |
|---|---|
| Claude Code and Codex hooks, every event | 1,000 ms |
| pi extension guard | 1,000 ms |
| Paseo permission | up to 9,500 ms |
| Paseo routing (act) | 1,500 ms |
| Paseo turn outcome | 59,500 ms |

Every decision kind is asked by the 1,000 ms hooks. A decision that misses its budget fails open.
Against that, measured p50 at 256 tokens: NPU d3:lite 228 ms and d3:mini 721 ms, Vulkan
`d3-lite-q8_0` 141–184 ms, Strands 2B on ROCm 596 ms and on CPU 2,426 ms. At 1,024 tokens the NPU
d3:mini takes 1,687 ms. Long states cost more, so a model that fits at 256 tokens may not at the
size a policy builds.

## 5. Other runtimes

- **LlamaStash and Ollama-style servers.** Reach them through `openai-compatible` (or `lmstudio`):
  the gateway does not manage them, and their models are uncalibrated. A chat model used as a
  decider took 26 to 71 s per decision in pi-automode-classifier's own numbers, so it fits no
  synchronous budget.
- **pi-automode-classifier users.** The pi extension registers a classifier provider named
  `local-decider` that serves whatever model the gateway runs ([pi plugin](../packages/pi-plugin/README.md)).
  Point the classifier at it, and `command-risk-binary` gives it the single-question shape.
- **LANCET Nano:** skipped. It is an unpinned downloaded Python process, and its server accepts
  only the `risky` question, so it ignores our criteria.
- **Laya:** skipped. There is no published GGUF to pin.
- **Julia-1:** skipped. Its author would not use it, because it prompts on every command.
- **Jev:** skipped. It is a hosted model, not local.
