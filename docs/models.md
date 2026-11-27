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
against 135 ms (a separate run) and 352 ms for `d3-lite-q8_0`. It has not been measured on `command-risk-binary`.
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
ranks by hardware instead, and it only picks calibrated engines. The table follows the selection
ladder (`LADDER` in `selector.ts`, walked by `rankEngines`). Its CUDA rung also serves AMD ROCm,
because ROCm torch reports as `cuda`:

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

**Per decision kind.** The table in section 3 is the per-kind recommendation, under the same rule:
a model is recommended for a kind only when it passes that kind's gate. Today that is the Strands
2B reference for every kind (`command-risk`, `permission`, `routing`, `turn-outcome` and
`command-risk-binary`). Automatic selection also picks it as the default model on the CUDA, ROCm,
Apple Silicon (MLX, MPS) and CPU rungs of the ladder; the NPU and Vulkan rungs pick a different
default ([engines.md](engines.md#5a-automatic-selection-and-fallback)). No other model is
recommended for any kind, so an own model for one decision (section 6) is an experiment, not a
recommendation: start it in `shadow` and read `local-decider stats` before it acts. When a
`mise run eval` run scores another model above the floors for a kind, that cell of section 3 and
this paragraph change; speed alone never changes them.

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

## 6. Switching the model for one decision

By default one model, the **default model** (`selection` in `config.yaml`, or what automatic
selection picked), answers every decision. A decision can have its own engine and model instead,
for example a small fast one for `command-risk` while the default model keeps the rest. A decision
with no model of its own behaves exactly as before.

**Set it.** Three ways, all saved to the same place:

```sh
local-decider engine use llama-vulkan d3-lite-q8_0 --policy command-risk
local-decider engine use lmstudio qwen3-4b-instruct-2507 --policy turn-outcome --fallback open
local-decider engine use default --policy command-risk      # back to the default model
```

```yaml
policies:
  command-risk:
    mode: shadow
    selection: { engine: llama-vulkan, model: d3-lite-q8_0 }   # fallback: default
  turn-outcome:
    selection: { engine: lmstudio, model: qwen3-4b-instruct-2507, fallback: open }
```

In Paseo, the **Decisions** table has a **Model** picker next to Mode on every row. It lists the
models that are installed, fit this machine and have an available engine, fastest first, and
**Default** first of all. The **Default model** row under **Status** shows what that is. Choosing
**Default** clears the decision's own model.

- `engine`, `model` and `device` are as in `engine use` ([engines.md](engines.md)); `device` is
  optional. `systemone-remote` cannot be an own model. The engine's options (`url`, `tokenEnv`,
  `ctxSize` and so on) come from the shared `engines.<id>` block, so two decisions on one engine
  share its connection settings.
- `engine use … --policy` checks the choice before it saves it, so a model that is unknown, not
  downloaded, does not fit or has no available engine is refused and nothing is saved
  (`POST /v1/policies/:id/selection`, [architecture.md](architecture.md#http-routes)). Editing
  `config.yaml` is lenient instead: the gateway applies it within a second (no restart), and a
  choice that cannot run becomes unavailable with a reason rather than stopping the gateway.
- A routing variant (`variantOf`) answers with its own `selection` if it has one, then its base
  policy's, then the default model.
- A decision whose own model is the very model the default uses answers as the default model. It
  stays on that model if the default model changes later.
- Setting a model never changes the mode, and the mode never changes the model.

**When it is unavailable.** The model is not installed, the engine is not available, it does not
fit, it would break one of the limits below, a benchmark is running, or the engine gave up after
its restarts. `fallback` decides what happens meanwhile:

| `fallback` | What answers |
|---|---|
| `default` (the default) | The default model answers, and the decision records `modelSource: fallback` |
| `open` | Nobody answers: the policy's default action, never enforced, `modelSource: unavailable` |

Both fail open: an own model never turns an unavailable model into a block. A single failed
decision (timeout, a 503, a bad answer) fails open for that decision alone and is not rerouted to
the default model. An own model's failures never trigger automatic fallback of the default model
([engines.md](engines.md#5a-automatic-selection-and-fallback)).

**Memory and limits.** The default model plus every own model that runs locally must fit in 80% of
the machine's memory. The default model comes first and always wins: an own model that no longer
fits next to it becomes unavailable, and the config stays as it is. The reason reads "does not fit
with the default model" or "needs ~N GB with the other models loaded; this machine allows ~M
GB". An own model on an `openai-compatible` or `lmstudio` server takes no memory here.
A decision whose mode is `off` loads nothing, but its model keeps its memory reserved, so
turning the decision on cannot overflow the machine.

- At most **3 different own models** run at once (`MAX_POLICY_LANES`). Decisions that choose the
  same model share one, a model equal to the default model takes none, and neither does a decision
  in mode `off`. A fourth is refused: "too many decisions with their own model (max 3)". Turning
  an `off` decision on can hit this limit.
- FastFlowLM serves one model on the NPU, so the default model and every own model together use
  at most one FastFlowLM model: "fastflowlm serves one model at a time; … already uses …".
- Own models follow the engine lifecycle (`lazy`: load on the first decision and unload when idle;
  `eager`: load at once, except for a decision in mode `off`). A cold model's load is not part of
  the decision's budget, so the first decision after a load may fail open.
- Each own model has its own queue and latency budget, but the gateway as a whole holds about 16
  waiting decisions. A decision refused for either reason fails open with `engine busy (503)`, like
  one for a busy default model.
- Answers are cached per engine and model, so a decision never reads another model's answers.
- A benchmark holds all decisions, the default model's included, and they fail open while it runs.
  Every own model is stopped and reads unavailable ("benchmark running"), so its decision follows
  its `fallback`; own models load again when the benchmark ends. Setting one during a benchmark
  is refused with 409.
- A downloaded model that a decision uses cannot be removed: clear it first.

**Thresholds were set for the default model.** The `command-risk`, `permission` and other
thresholds were tuned against the reference model's probabilities, and a different model's
probabilities have a different shape, so the same thresholds can ask too often, or too rarely. Run
a decision on its own model in `shadow` first and read `local-decider stats` before you let it
`act`. Paseo says this when you set a model on a decision in `act`. Models that nobody has calibrated
(the OpenAI-compatible and LM Studio ones) need this most. The deterministic guard in the Claude
Code and Codex hooks does not depend on any model.

**See which model answered.**

- `local-decider engine list` ends with a `Decisions:` block, one line per decision that has its
  own model (`command-risk: llama-vulkan d3-lite-q8_0 (own model, ready)`), or "Decisions: all use
  the default model". An unavailable one reads `unavailable: <reason> → default model` (or
  `→ skipped`), one in mode `off` reads `(off, not loaded)`, and one whose model is the default
  model reads `(same as the default model)`.
- `local-decider explain <id>` names the engine and model of the decision, followed by `(own
  model)`, `(default model; own model unavailable)` or `(skipped: own model unavailable)`.
  `modelSource` in the response and the decision log says the same: `default`, `policy`, `fallback`
  or `unavailable`.
- `local-decider stats` adds a `models:` line for a decision when more than one model answered it,
  or when an own model or a fallback answered.
- Paseo's decision rows say "own model", "default (own model unavailable)" or "skipped: own model
  unavailable"; the quick-status popover adds an "Own model: …" line under a decision that has one;
  a Model row badge says "loading", "unavailable" or "too slow" (typical latency above the hooks'
  1 s budget, so Claude Code, Codex and pi skip most of its decisions).
- `GET /v1/policies` lists each decision's `selection`, `selectionStatus` and `modelSource`, and
  `GET /v1/engines` and `/health` list the own models and their state.

**Evaluate a model for one decision kind.** `mise run eval` scores the model behind
`/v1/systemone`, which stays the default model, so make the candidate the default model for the
run, then restore the old one:

```sh
local-decider engine use llama-vulkan d3-lite-q8_0
mise run eval -- --policy command-risk --out /tmp/eval-d3-lite
local-decider engine use strands-decider StrandsAgents/strands-decider-2B-qwen3.5-v1-2610
```

Note your `selection` in `config.yaml` first, because `engine use` overwrites it. The run exits 1
when the policy falls below the per-class floors in `policies/fixtures/gate.json`. A model that
passes can then be tried as that decision's own model, in `shadow`. The recorded fixtures and
`mise run eval:record` are not affected by an own model: state building, redaction, truncation, the
criteria and the questions are the same on every lane.
