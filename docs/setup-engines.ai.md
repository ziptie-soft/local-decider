# Set up a decision engine for local-decider (guide for AI agents)

You are an agent installing local-decider for a user. Follow the steps in order and skip a step
whose check already passes. Commands are fish-compatible. Steps marked **Ask the user first** need
the user's explicit yes. If a step's check fails twice, stop and report the output to the user.

This guide is the engine step shared by the install guides:
[Claude Code](install-claude.ai.md), [Codex](install-codex.ai.md), [pi](install-pi.ai.md) and
[Paseo](install-paseo.ai.md). The gateway (`@ziptie-soft/local-decider`) must already be installed.
Background: [install.md](install.md#2-engine).

## 1. Pick an engine for the hardware

`local-decider engine install` with no flags picks for the hardware, in this order: AMD NPU,
NVIDIA CUDA, Vulkan GPU, Apple MLX, Apple MPS, CPU. It prints the reason. Use an explicit command
only when the user wants a different engine.

| Hardware | Command | Default model | Notes |
|---|---|---|---|
| Any CPU (Linux default when no GPU is detected) | `local-decider engine install` | 2B, ~4.8 GB download | 1.2–2.5 s per short decision |
| Apple Silicon (macOS default) | `local-decider engine install` | 2B on MLX | `--flavor mlx` is picked for you |
| NVIDIA GPU | `local-decider engine install --flavor cuda` | 2B | needs the NVIDIA driver |
| AMD GPU with ROCm (Linux) | `local-decider engine install --flavor rocm` | 2B, plus ~3 GB of ROCm torch | ROCm torch reports the GPU as `cuda` |
| AMD Ryzen AI NPU (Linux) | `local-decider engine install --engine fastflowlm --model d3:mini` | `d3:nano` without `--model` | 0.25–0.6 s per short decision |
| Linux x86_64 Vulkan GPU | `local-decider engine install --engine llama-vulkan` | d3-mini Q4_K_M | you install a Vulkan-enabled `llama-server`; only the GGUF is downloaded |

If the user already runs a local model server (LM Studio, Ollama, llama-server), see
[install.md](install.md#openai-compatible-servers) instead; nothing is downloaded for those.

## 2. Install prerequisites

Each engine needs one tool that local-decider does not download. [mise](https://mise.jdx.dev)
installs it for the user.

- **strands-decider (CPU, CUDA, Apple Silicon):** only `uv` is needed.

  ```sh
  mise use -g uv
  ```

- **FastFlowLM (AMD NPU, Linux):** needs Linux 6.14 or newer with the in-tree `amdxdna` driver and
  NPU firmware from `linux-firmware`; these come from the distribution. **Ask the user first**
  before any `sudo` or system package. Then:

  ```sh
  mise use -g 'github:FastFlowLM/FastFlowLM[asset_pattern=fastflowlm_*_linux.tar.gz]@1.0.12'
  flm validate
  ```

  `flm validate` must report the NPU and an `infinity` (or large) memlock limit.

- **llama.cpp Vulkan (Linux GPU):** needs a hardware Vulkan driver and `vulkaninfo` from the
  distribution. **Ask the user first** before running any of these:

  ```sh
  sudo dnf install mesa-vulkan-drivers vulkan-loader vulkan-tools        # Fedora
  sudo apt install mesa-vulkan-drivers libvulkan1 vulkan-tools           # Debian, Ubuntu
  ```

  Then install the pinned llama.cpp build:

  ```sh
  set tag (curl -fsSL https://github.com/ggml-org/llama.cpp/releases/latest/download/nightly-tag.txt)
  mise use -g "github:ggml-org/llama.cpp[asset_pattern=llama-*-bin-ubuntu-vulkan-x64.tar.gz]@$tag"
  llama-server --version
  llama-server --list-devices
  ```

  `llama-server` needs build 11572 or newer; `--list-devices` should list a Vulkan device that is
  not llvmpipe.

- **NVIDIA CUDA:** the NVIDIA driver comes from the distribution (**Ask the user first**).

## 3. Install the engine

**Ask the user first**: the download is several GB (about 4.8 GB for the default 2B model).
Run the command from the table in step 1, for example:

```sh
local-decider engine install
```

`--no-download` skips only the model weights; strands-decider still runs `uv sync --locked` and
needs network access. Installing never switches the running engine.

## 4. Verify

```sh
local-decider gateway status
local-decider decide turn-outcome lastMessage="All tests pass; the PR is open."
```

`gateway status` should report the gateway as `"status":"ok"`. `decide` prints the answers, the
action and `"enforced": false` (shadow). The engine loads on the first decision, which can take
several seconds (about 5 s on FastFlowLM, longer on CPU). When this passes, return to your install
guide.

## 5. Troubleshooting

- `flm` or `uv` not found by the gateway's systemd user unit: its PATH may lack
  `~/.local/share/mise/shims`. Point the gateway at the shims in
  `~/.config/local-decider/config.yaml` (`local-decider config path` prints the location):

  ```yaml
  tools:
    uv: /home/you/.local/share/mise/shims/uv
    flm: /home/you/.local/share/mise/shims/flm
    llamaServer: /home/you/.local/share/mise/shims/llama-server
  ```

- `llama-vulkan` reports no Vulkan device: install `vulkan-tools` and check
  `llama-server --list-devices`; software renderers such as llvmpipe are excluded.
- mise picked the CPU or CUDA llama.cpp build: keep the `asset_pattern` in the `mise use` command.
- Fedora's `llama-cpp` package is a HIP/ROCm build and predates d3 support; use build `b11572` or
  newer, compiled with Vulkan.
- Check the config with `local-decider config check`. Engine logs are in
  `~/.local/share/local-decider/logs/` (`engine-<id>.log`).
