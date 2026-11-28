# Benchmarks

All numbers were measured on one machine: an AMD Ryzen AI 9 365 with 61 GB RAM, on 2026-11-10.
Your hardware and models will give different numbers.

Method: `local-decider bench --sizes 256,1024,2048,3800 --runs 5` against a running gateway.
One `choice` question (4 options, the turn-outcome question) over synthetic transcript state,
after one warm-up request per size. Latency is measured at the client.

## Benchmark your machine

Numbers below are one machine's. Measure yours: a run times every installed model on every
runtime, one at a time, on a typical request (about 1,000 tokens; the CLI's `--sizes` adds
others), and saves the results for the recommendation. The CPU is skipped: it is too slow for live
decisions and never picked automatically. Name it to measure it anyway
(`--engines strands-decider:<model>@cpu`).

**In the Paseo plugin.** Settings, Local decider, **Benchmark**. The card shows one table: installed
models by processor (NPU, GPU, CPU), each cell the median decision time, the fastest of each row
marked. Run benchmark, Cancel and Measure missing only live on the card; a failed pair is listed
with its error and its own Retry. See the
[plugin overview](../packages/paseo-plugin/OVERVIEW.md#benchmarks).

**On the command line.** The gateway must be running.

```fish
local-decider bench
local-decider bench --installed
local-decider bench --family vllm-sr/d3-mini
local-decider bench --engines fastflowlm:d3:mini,llama-vulkan:d3-mini-q4_k_m
local-decider bench --engines strands-decider:StrandsAgents/strands-decider-2B-qwen3.5-v1-2610@cuda
local-decider bench --installed --missing --sizes 256,1024,3800 --runs 5 --json
```

| Flag | Meaning |
|---|---|
| none | Benchmark the engine that is running now (the result is saved too). |
| `--installed` | Every installed, downloaded model that fits, on every runtime. Custom servers (OpenAI-compatible, LM Studio) are skipped. |
| `--family ID` | The same, restricted to one model family. |
| `--engines ENGINE:MODEL[@DEVICE],...` | Explicit targets, at most 32. The model is everything after the first `:`, so `fastflowlm:d3:mini` is model `d3:mini`. `@DEVICE` (`cpu`, `mlx`, `mps`, `cuda`) is read only when it is a real device; strands-decider needs one. |
| `--missing` | Drop targets that already have a fresh, ranked result. |
| `--sizes 256,1024,3800` | Prompt sizes in tokens, whole numbers from 64 to 8,192, at most 6. 1,024 is always measured. |
| `--runs 5` | Timed runs per size, 1 to 20. One or two runs are saved as provisional and do not rank anything. |
| `--json` | Print only the final job as JSON. |

Use at most one of `--installed`, `--family` and `--engines`; mixing them is a usage error.

The command prints a header (`bench <url> targets=<n> sizes=<...> runs=<n>`) and one line per
target (`fastflowlm d3:lite (NPU)`). Then, as each target finishes, it prints that target's name
again with its load time and one line per size
(`1024 tok (engine 978): p50 532 ms, p95 541 ms, answer=done`, with `provisional` added when
the run count is under 3), or `failed: <error>` for a target that did not work. A target that was
interrupted reads `not measured (cancelled)` and one the job never reached reads `not run`. At the
end it prints `restored <engine> <model>` or `restore failed: <error>`, then `cancelled (<reason>)`
or `benchmark failed: <error>` when the job ended that way. With `--json` nothing is printed until
the job ends, then only the final job.

A run calls the engine directly, past the decision cache, queue and shadow log, so its numbers can
be a little lower than the older figures below, which went through `/v1/systemone`.

| Exit code | When |
|---:|---|
| 0 | The job finished and at least one target succeeded. |
| 1 | Every target failed, the job failed, someone else cancelled it or a selection change preempted it, a benchmark was already running or the request was refused (409 or 401), or the gateway was not reachable. |
| 2 | Usage error. |
| 130 | Ctrl-C. |

**Ctrl-C** cancels the job on the gateway and waits up to 30 s for it to end, then exits with
130 either way; what finished is kept. A second Ctrl-C exits at once and leaves the gateway to
finish the cancel.

**While it runs**, decisions fail open (`engine benchmark running`), so hooks and agents carry on
without an answer, and the previous engine is restored afterwards. A run takes minutes, longer on
the CPU and when engines must load. Results are from this machine only; see
[engines](engines.md#5b-model-families-and-the-recommendation).

**API.** All three routes are control routes: they need the control token (the
`x-local-decider-control` header, or the bearer token when `LOCAL_DECIDER_TOKEN` is set).

| Route | Does |
|---|---|
| `GET /v1/benchmark` | The job's state, phase, targets and results, and a preview of what the next run would do. |
| `POST /v1/benchmark` | Starts a job; 202 with its view. Fields are all optional: `scope` (`installed`, `family`, `active`), `family`, `targets`, `only: "missing"`, `sizes`, `runs`, `client`. 400 for a bad body, 409 when a job is running or nothing is left to measure. |
| `POST /v1/benchmark/cancel` | Cancels the running job; 202. 409 when none runs. |

**Where results are kept.** `~/.local/share/local-decider/benchmarks.json`, a 0600 file in a 0700
directory, written atomically, at most 500 records (the oldest are dropped first). A file that is
too large, damaged or from an unknown version is moved aside as `benchmarks.json.corrupt-<time>`
and the store starts empty. Delete the file to forget all results.

## Strands 2B on CPU

`StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`, `strands-decider serve --device cpu
--max-batch 8`, torch 2.15.0+cpu, fp32, strands-decider @ `846b69e`.

| Target tokens | Engine input tokens | p50 | p95 |
|---:|---:|---:|---:|
| 256 | 336 | 2,426 ms | 2,655 ms |
| 1,024 | 944 | 5,468 ms | 5,531 ms |
| 2,048 | 1,753 | 11,127 ms | 11,730 ms |
| 3,800 | 3,139 | 19,310 ms | 19,765 ms |

- Roughly 2 s fixed plus 5.5 ms per token. Short real decisions (100–200 tokens) took 1.2–1.6 s.
- A full 4,096-token state cannot be sent: the window is 4,096 tokens including the question.
- On CPU the decider is a shadow and background tool. Hooks give up after 1.5 s and fail open;
  the gateway still finishes and logs shadow decisions. For that reason automatic selection never
  picks the CPU, it is never a fallback, and a default benchmark skips it.
- The default policies keep state small: `command-risk` 1,000 tokens, `routing` 1,500,
  `permission` 2,500, `turn-outcome` 3,000.

## FastFlowLM 1.0.12 on the XDNA2 NPU

Same machine and benchmark, `flm serve --decision <model>` (portable build, `--pmode
performance`), measured directly against FLM's `/v1/systemone`.

| Target tokens | Engine tokens | d3:lite p50 / p95 | d3:nano p50 / p95 | Strands 2B CPU p50 |
|---:|---:|---:|---:|---:|
| 256 | 370 | 228 / 237 ms | 325 / 346 ms | 2,426 ms |
| 1,024 | 978 | 532 / 541 ms | 764 / 887 ms | 5,468 ms |
| 2,048 | 1,787 | 929 / 960 ms | 1,351 / 1,379 ms | 11,127 ms |
| 3,800 | 3,173 | 1,646 / 1,678 ms | 2,367 / 2,400 ms | 19,310 ms |

- 7–11× faster than the 2B on CPU at every size. A lazy model load takes about 5 s.
- Through the gateway (redaction, state shaping, queue, rules), a short decision took 250 ms on
  d3:nano and about 600 ms on d3:mini.
- An opt-in integration run (`LOCAL_DECIDER_IT_ENGINE_URL`) of six cases (turn outcome done and
  needs_input, command risk dangerous and safe, permission allow and deny) was seen to pass on
  d3:mini, with `cat README.md` at p(allow) = 0.97 against 0.93 on the 2B. No fixture backs
  those numbers. For measured rates see the fixture eval
  ([policies.md](policies.md#fixtures-and-the-ci-gate)).
- d3:mini is the recommended FastFlowLM model and d3:nano the fast one.

## GPU (Radeon 880M iGPU) against the NPU

Measured on 2026-11-12 on the same machine with `local-decider bench --sizes 256,1024,2048,3800
--runs 5` through the gateway, after `local-decider engine use <engine> <model>`. llama.cpp
b12110 (v0.9.0) Vulkan build from mise. Strands ran on `torch 2.14.1+rocm7.2` in a scratch venv,
measured directly against `strands-decider serve --device cuda`. Every number is p50.

| Target tokens | Vulkan d3-lite Q8_0 | NPU d3:lite | Vulkan d3-mini Q4_K_M | Vulkan d3-mini Q8_0 | NPU d3:mini | NPU d3:nano | Strands 2B ROCm | Strands 2B CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 256 | 141–184 ms | 208–232 ms | 817 ms | 701 ms | 721 ms | 335 ms | 596 ms | 2,426 ms |
| 1,024 | 394–529 ms | 482–555 ms | 2,307 ms | 2,008 ms | 1,687 ms | 760 ms | 1,419 ms | 5,468 ms |
| 2,048 | 977 ms | 934 ms | 4,316 ms | 3,863 ms | 3,038 ms | 1,345 ms | 2,658 ms | 11,127 ms |
| 3,800 | 1,550–1,991 ms | 1,509–1,693 ms | 8,717 ms | 7,745 ms | 5,322 ms | 2,353 ms | 4,915 ms | 19,310 ms |

Ranges come from interleaved runs (Vulkan, NPU, Vulkan, NPU) under the same load.

- **d3-lite:** the Vulkan GPU is 15–35% faster on short states. From about 2k tokens the GPU and
  NPU are level. GPU p95 is noisier, because the integrated GPU is shared with the desktop
  compositor and Electron apps. The NPU is not shared and its p95 stays close to its p50.
- **d3-mini:** the NPU is faster than Vulkan Q4_K_M at every size, by 1.1× at 256 tokens and 1.6×
  at 3,800.
- **Q8_0 against Q4_K_M on Vulkan:** d3-mini Q8_0 is about 13–14% faster than Q4_K_M at 256 and
  1,024 tokens, and about 11% faster at 2,048 and 3,800. Its p95 is noisy, up to 10.6 s at 3,800
  tokens. The NPU d3:mini is still faster from 1,024 tokens up.
- **llama.cpp builds:** b12110 and b12318 gave the same `llama-bench` prompt throughput on d3-lite
  Q8_0 (about 2,370 tokens/s at pp512).
- **Strands 2B on ROCm:** about 4× faster than on the CPU. Setting
  `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` improved long states by about 25% (see
  [engines](engines.md#5-macos-and-linux-defaults)). These numbers ran in a scratch venv; the same
  torch now comes from `engine install --flavor rocm`, which an explicit config picks on its own on
  an AMD GPU host.

## Kev 0.8B on llama.cpp (Vulkan)

Kev 0.8B Q8_0 (`ggml-org/Kev-0.8B-GGUF`, `kev-0.8b-q8_0`) against d3-lite Q8_0 on the same
`llama-server`. Hardware: AMD Ryzen AI 9 365 with Radeon 880M (Vulkan). Build: llama.cpp b12110
(`0.9.0-dev`, commit cd959bae9).

Conditions: a second gateway from source on port 8766, while the live gateway sat idle with
Strands 2B resident on the same iGPU. The numbers may be pessimistic. 5 runs per size.

| Model | Tokens (state) | p50 | p95 |
|---|---|---|---|
| Kev 0.8B Q8_0 | 256 | 156 ms | 185 ms |
| Kev 0.8B Q8_0 | 1,024 | 435 ms | 541 ms |
| d3-lite Q8_0 | 256 | 135 ms | 137 ms |
| d3-lite Q8_0 | 1,024 | 352 ms | 354 ms |

Both load in 1.1 s. Kev's engine token counts are 298 and 906, d3-lite's 370 and 978.

**Memory.** The `llama-server` resident set was 312 MB with Kev loaded. On Vulkan the weights
live in GPU-mapped memory, so RSS undercounts the footprint (the file is 774 MB). `memoryGb`
therefore stays at 1.5: the file (0.81 GB) plus the KV cache at ctx 4096. The iGPU's GTT use
cannot be attributed to Kev here, because Strands was resident too.

**Quality.** The reference is Strands 2B (`strands-decider-2B-qwen3.5-v1-2610`, ROCm) through the
same second gateway, with `mise run eval -- --out`. Kev's probabilities are close to flat, so its
answers often fall below the policy thresholds, and its actions are `ask` or the policy default.
"Agree" is the share of cases where Kev's action equals the reference's action.

| Policy | Agree with reference | Kev's gate |
|---|---|---|
| command-risk | 23/44 | fail: dangerous 0/11, safe 0/14 |
| permission | 75/89 | fail: allow 0/33, deny 0/13 |
| routing | 14/30 | fail: fast 2/10, standard 0/10, deep 0/10 |
| routing-budget | 17/30 | fail: cheap 0/10, premium 0/10 (standard 0/10, floor 0.0) |
| routing-task-kind | 17/25 | fail: code 3/5, debug 2/5, plan 3/5 |
| turn-outcome | 18/36 | fail: needs_input 0/10, stuck 1/11, failed 1/5 |

The reference passed every gate. Kev fails every policy, so it is not recommended for any decision
kind. Its permission agreement is high only because both models mostly ask.

## Other paths

- **macOS (MLX):** not measured yet. Upstream reports 113 ms at 222 tokens for the 2B v19 model
  on an M4 Pro.
- **Encoder models:** GLiClass measured 99 ms on a short state and 455 ms at about 600 tokens on
  this CPU. There is no engine adapter for it; it can be reached as a `systemone-remote` server.
