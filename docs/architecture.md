# Architecture

local-decider puts a small local decision model in front of routine, fixed-choice decisions in
coding-agent harnesses. This page shows the pieces and how one decision flows through them. The
reasons behind each choice are in the [architecture decision records](adr/).

## Components

```mermaid
flowchart LR
  subgraph Harnesses
    PA["Paseo daemon + local-decider plugin"]
    CC["Claude Code + hooks"]
    CX["Codex + hooks"]
    MC["MCP clients"]
    CLI["local-decider CLI"]
  end
  subgraph Gateway["Gateway (Node, 127.0.0.1:8765)"]
    HTTP["HTTP routes + MCP server"]
    DEC["Decider: redact, state, cache, rules, precedent"]
    POL["Policies (YAML) + config.yaml (live reload)"]
    Q["Engine queue (by priority, one slot per engine request)"]
    LOG[("SQLite decision store")]
    ST["Stats: agreement, calibration, savings"]
  end
  subgraph Engines
    SD["strands-decider serve (uv venv)"]
    FL["FastFlowLM flm serve (NPU)"]
    RM["Any /v1/systemone server"]
  end
  PA --> HTTP
  CC --> HTTP
  CX --> HTTP
  MC --> HTTP
  CLI --> HTTP
  HTTP --> DEC
  POL --> DEC
  DEC --> Q
  Q --> SD
  Q --> FL
  Q --> RM
  DEC --> LOG
  LOG --> ST
```

| Piece | Path | What it does |
|---|---|---|
| Core | `packages/core` | `/v1/systemone` types and answer normalisation, policy schema and rules, redaction, truncation, gateway client |
| Gateway | `packages/gateway` | HTTP service, engine supervisor, decider, SQLite decision store, stats, MCP server, `local-decider` CLI, service units |
| Hooks | `packages/hooks` → `plugins/local-decider/dist/local-decider-hook.mjs`, `hooks/local-decider-auto-mode.mjs` (built at release, published as `@ziptie-soft/local-decider-agent-plugin`) | One zero-dependency hook runner for Claude Code and Codex, with the deterministic guard, and the Claude Code auto-mode mod |
| Paseo plugin | `packages/paseo-plugin` | Hooks, decision rows, settings and status screens; never runs a model in-process |
| Policies | `policies/` | Default policies and eval fixtures |

## One decision

```mermaid
sequenceDiagram
  participant H as Harness
  participant A as Hook or plugin
  participant G as Gateway
  participant E as Engine
  participant L as SQLite store
  H->>A: event (tool call, permission, turn end, new agent)
  opt Claude Code or Codex PreToolUse
    A->>A: deterministic guard, deny on a hit
  end
  A->>G: POST /v1/decide/:policy
  G->>G: policy and mode, off returns abstain
  G->>G: redact secrets, build state within maxTokens
  G->>G: precedent key from the redacted subject
  G->>E: state + questions (queued, cached by input hash)
  E-->>G: probabilities per option
  G->>G: first matching rule, else policy default
  G->>L: append decision record (hashes, answers, action)
  G-->>A: action, answers, enforced
  alt enforced and supported for this event
    A->>H: allow, ask, deny, route or highlight
  else shadow, error, timeout or gateway down
    A->>H: no output, harness default
  end
```

Step by step:

1. **Policy and mode.** The gateway looks up the policy and its effective mode (`config.yaml`
   beats the YAML file). A selected variant answers with its own questions and rules. `off`
   returns `abstain` without calling an engine.
2. **Redact and shape.** Every input string is redacted (`core/redact.ts`). The state sections
   are rendered in policy order, objects as key-sorted JSON, and trimmed to `state.maxTokens`
   (`core/truncate.ts`).
3. **Engine.** Answers are cached by input hash for the policy's `cache.ttlSeconds`. Otherwise the
   request joins the engine queue: one request at a time (as many as the engine's
   `maxConcurrency` for `strands-decider`), `high` priority policies first; shadow decisions run
   at `low`. At most 8 decisions wait or run (7 waiting places beyond the slots); `normal` ones
   are refused from 6, and a `high` one arriving at the maximum evicts the oldest waiting `low`
   one. While a managed engine loads,
   `normal` and `low` decisions are refused once 6/8 are waiting (counting the load); `high` ones
   are not. A caller that gives up leaves the queue at once; a managed engine loads before its
   request takes the queue; a job that ignores its deadline loses the engine 1 s later. A full
   queue, an engine error or the deadline (`decisionTimeoutMs`, 30 s) returns an `error` with the
   policy default and `enforced: false`.

   **`budgetMs` admission.** A `POST /v1/decide/:policy` body may carry `budgetMs`, the time the
   caller will wait in milliseconds. The gateway estimates the queue wait as the full waves of
   jobs ahead (`depth / slots`, rounded down) times the rolling mean engine call time (the last 50
   calls, queue wait excluded). When that exceeds `budgetMs` it answers at once, without queuing,
   with `error: "engine busy (503)"`, the policy default and `enforced: false`: the shape of an
   engine 503. A free slot or a cold average always admits, a cache hit or a join of a running
   identical call skips the check, and shadow decisions are never refused. The hooks, the Claude
   Code mod and the Paseo plugin send their timeout minus 500 ms
   (`LOCAL_DECIDER_TIMEOUT_MS`, default 1500 ms); a timeout of 500 ms or less sends none. Busy
   answers count under `busy` in `/v1/stats` (also part of `errors`) and never enter calibration
   or agreement. A busy engine is not an engine failure.
4. **Rules.** The first matching rule wins. A precedent rule also needs enough recent allows of
   the exact subject and no veto ([policies.md](policies.md#precedent)).
5. **Log and answer.** `enforced = mode is act and no error`. A shadow decision keeps running
   after the caller gives up, so it is still logged.

Adapters change behaviour only when `enforced` is true, and only in ways their event allows:

| Adapter | Event → policy | What an enforced action can do |
|---|---|---|
| Paseo | `agent.turn.after` → `turn-outcome` | Highlight `notify` in the chat row; never sends a prompt |
| Paseo | `agent.permission.before` → `permission` | Auto-allow a tool request; never denies |
| Paseo | `agent.create.before` → `routing` | Switch provider, model, mode and thinking, or start from a profile (2 s client timeout, `DEFAULT_TIMEOUT_MS` in `paseo-plugin/shared/gateway.ts`) |
| Claude Code | `PreToolUse` → guard, write guard (incl. Bash redirects), then `command-risk` | `deny` or `ask`; in auto mode `ask` prints nothing |
| Claude Code, auto mode | mod `tool.check` → `permission` (scope `claude-auto`) | `allow` of a plain ask, in `act` only |
| Codex | `PreToolUse` → guard, write guard (incl. `apply_patch`, redirects), then `command-risk` | `deny` only |
| Claude Code, Codex | `PermissionRequest` → `permission` | `allow` only; abstains for outside-cwd, protected or risky targets |
| Claude Code, Codex | `UserPromptSubmit` → `routing` | Add a hint that names the mapped model |
| Claude Code, Codex | `Stop` → `turn-outcome` | Nothing: logged only, since Stop output would continue the turn |
| Claude Code | `PostToolUse` on `Agent`/`Task` (argv event `SubagentResult`) → `turn-outcome` | In `act` mode, tell the parent when the subagent looks `stuck` or `needs_input`; notify only |

In Claude Code auto mode the plugin's mod
(`plugins/local-decider/hooks/local-decider-auto-mode.mjs`, built from `packages/hooks/src/mod/`)
asks `permission` before the server-side classifier does:

```mermaid
sequenceDiagram
  participant C as Claude Code
  participant K as PreToolUse hook
  participant M as Mod tool.check
  participant G as Gateway
  participant X as Classifier
  C->>K: Bash call, tool_use_id, auto mode
  K->>G: command-risk with the call id and mode
  C->>M: tool.check
  M->>C: next(e), a plain ask comes back
  M->>G: GET /v1/calls/:id, then POST /v1/decide/permission (scope claude-auto)
  alt scope in act, allow enforced, path and command checks pass
    M-->>C: allow, no classifier
  else shadow, ask, timeout or error
    M-->>C: the ask, so the classifier decides
    C->>X: classify
  end
```

It records the classifier's verdict as an outcome (`source: classifier`) for
`local-decider stats --scope claude-auto`. Details and limits: [ADR-0007](adr/0007-claude-auto-mode-mod.md).

The Paseo plugin needs both the gateway mode and its own setting at `act`. Inside Paseo, Claude
Code and Codex agents also load the hooks. The Paseo plugin sets
`LOCAL_DECIDER_HOST_POLICIES=turn-outcome,permission,routing` on agents it opens, so the hooks
skip those and run only the guard and `command-risk`.
Before it auto-allows, the plugin runs the same deterministic path and command check as the
hooks (vendored from core); a flagged call stays pending for the user, and it never denies.

The hook reads stdin in tiers: up to 4 MiB it runs the guard and the gateway; up to 32 MiB it
parses the payload and runs only the deterministic guard (no gateway call); beyond that it stops
reading and a `PreToolUse` asks (Claude) or is denied (Codex). Other events fail open. A shell
command over 1 MiB asks or denies the same way. `LOCAL_DECIDER_GUARD=off` restores fail-open.

## Outcomes, usage and stats

```mermaid
flowchart LR
  D["Decision record"] --> LOG[("Decision log")]
  U["Your Accept or Decline on a Paseo prompt (decline is neutral)"] -->|"POST /v1/outcomes, source user"| LOG
  P["Parent agent's answer to a child"] -->|"source supervised"| LOG
  L["Label chips on Paseo permission rows"] -->|"unsafe, source user"| LOG
  F["Right answer? buttons on Paseo rows"] -->|"source user"| LOG
  T["Token usage of agents a Paseo routing decision created"] -->|"POST /v1/usage"| LOG
  LOG --> S["local-decider stats"]
  S --> A["Agreement, Brier, reliability buckets"]
  S --> C["Calibration hints (advisory)"]
  S --> SV["Savings: potential (shadow), realized (act)"]
  LOG -->|"rebuilt at start and when precedent settings change"| PR["Precedent store"]
  PR --> R["Precedent rule in the next decision"]
```

- **Records.** `decision` records hold the input hash, canonical precedent key, answers, action,
  model and latency. `outcome` and `usage` records join them by `decisionId`. Only token-verified
  `user` and `supervised` outcomes add allow evidence or feed calibration; configured unverified
  veto sources can only add a veto. Agreement and reliability stats use verified outcomes only,
  and `decline` and `interrupted` are not labels of the model's answer. Unverified outcomes and
  usage are counted apart as `unverified: {outcomes, usage}` in `/v1/stats`; only the auto-mode
  classifier comparison reads unverified `classifier` reports. Corrections (a
  neutral outcome upgraded to `unsafe`) are appended outcome rows. No state text is
  logged. They live in a SQLite database at `~/.local/share/local-decider/decider.db`, pruned
  after `logs.retainDays` (default 365; range 90–3650 days). Prune also drops outcome and usage
  rows whose decision is gone, and unverified rows older than 30 days. Usage rows from before
  the report-token gate stay verified. It is hash-only, uses WAL for
  concurrent reads, stores hashes and structured decision metadata rather than state text, and
  has no encryption at rest. `local-decider logs backup <file>` uses
  `VACUUM INTO`; `local-decider logs export [--since YYYY-MM-DD] <dir>` writes JSONL portability
  files. JSONL is not a live storage backend. Schema changes use `PRAGMA user_version` migrations.
- **Statistics.** `GET /v1/stats?days=N` and `local-decider stats --days N` use a 30-day default;
  `N` must be from 1 through `logs.retainDays`. The gateway computes statistics in a worker
  thread using its own read-only SQLite connection. A 30-second timeout returns HTTP 503.
- **Precedent.** Startup rebuilds only the largest `precedent.maxAgeDays` window configured by
  the policies. A workspace is required for precedent; requests without one do not use it. The
  gateway stores one canonical key from the `v2` format tag, policy, lexically normalised cwd and
  canonical subject. Existing precedent hashes are discarded because they cannot be converted. A
  policy's `vetoSources` may allow unverified classifier, harness or heuristic denials to veto,
  while those sources can never add allow evidence. A policy reload skips rebuilding when
  precedent settings are unchanged.
- **Who reports.** Paseo reports user outcomes and usage. The Claude Code auto-mode mod reports
  classifier denials as unverified vetoes; plain Claude Code and Codex hooks cannot see the
  user's answer.
- **Calibration hints.** For probability-based allow rules, `stats` may suggest a lower threshold
  when at least 100 escalated, labelled decisions meet it and the Wilson 95% upper bound on the
  deny rate is at most 2%. It never changes the config.
- **Calibration report.** `local-decider calibrate [--json]` fits a temperature per policy,
  engine and model from verified outcomes and stored probabilities. It reports Brier and ECE
  before and after, plus allow-threshold suggestions when data is sufficient. It writes no config.
- **Savings.** A routing request may carry `models: {requested, routes, profiles}`. The gateway
  fills missing routes from `config.yaml` presets and resolves a `profile` preset through
  `profiles`. With verified usage reported, stats sum the tokens of tasks routed to another model,
  priced when `pricing` is set. Shadow savings are an upper bound.
- **Prompt time.** For allow policies, stats show prompts you answered that the policy would have
  allowed, and how long they waited (capped at 10 minutes each).

## Engines

| Engine | What it runs |
|---|---|
| `strands-decider` | Spawns `strands-decider serve <model> --device cpu\|mlx\|mps\|cuda` from the managed uv venv, or attaches to `engine.url` |
| `fastflowlm` | Spawns `flm serve --decision <model>` on the AMD XDNA NPU (Linux), or attaches to `engine.url` |
| `llama-vulkan` | Spawns a user-installed Vulkan-enabled `llama-server` on loopback for native `/v1/systemone` d3 decisions |
| `systemone-remote` | Any `/v1/systemone` server at `engine.url`, with an optional bearer token from `tokenEnv` |
| `openai-compatible` | Scores one option token from an OpenAI-style server's logprobs (LM Studio, Ollama, llama-server, `mlx_lm.server`); uncalibrated |

Each engine is one descriptor in a registry; see [engines.md](engines.md) for the engine table,
how to add an engine or a model, and the macOS notes
([ADR-0008](adr/0008-engine-registry.md)).

- **Supervision.** A spawned engine runs on a free loopback port and logs filtered stdout/stderr
  to `logs/engine-<id>.log`. Lines containing request `state` or `questions`, and lines over 500
  characters, are discarded. Logs over 10 MiB rotate to one `.1` file. After a crash the engine
  restarts with exponential backoff (2 s doubling to 32 s), at most 5 times; a 5-minute healthy
  run resets that budget. An engine that never becomes healthy, or exhausts the budget, is
  killed (SIGTERM, then SIGKILL after 10 s) and marked `failed`; a decision then starts it again
  at most once per 60 s, and concurrent starts share one attempt, so a crash loop never piles up
  children. Three consecutive decision timeouts trigger a `/health` probe: no answer restarts the
  engine, an answer only logs "slow". `systemone-remote` retries transport errors and HTTP
  500/502/504 twice and flips to `failed` only if `/health` is silent too;
  `openai-compatible` retries transport errors only. The gateway process logs and survives
  unhandled rejections and exits on an uncaught exception, so the service manager restarts it.
- **Lifecycle.** `lazy` (default) loads the model on the first decision and unloads it after
  `idleUnloadMinutes` (15). `eager` loads it at start. A decision that arrives while the model
  loads waits for it.
- **Limits.** Engine responses over 1 MiB are rejected while streaming.
- **Switching.** `POST /v1/engine`, `local-decider engine install` and the Paseo settings page
  switch strands-decider, FastFlowLM and openai-compatible models at runtime; the choice is saved
  as `selection`. A remote or `engine.url` engine cannot switch (409).

## HTTP routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/decide/:policy` | Open | Run a policy on harness input |
| `POST /v1/systemone`, `POST /invocations` | Open | Pass-through to the active engine (keys sorted, secrets redacted) |
| `POST /v1/outcomes`, `POST /v1/usage` | Report / open | Report what happened, and token usage, for a decision. Both return 404 for an unknown `decisionId`; an outcome must be `allow`, `deny`, `unsafe`, `decline`, `interrupted` or an answer label of the decision, else 400. Without the report token the rows are stored unverified and limited to 60 per minute per route (burst 30, then 429) |
| `GET /v1/calls/:id` | Open | What each policy decided for a harness tool call (`call.id` of a decide request), its permission mode and the effective mode per scope; kept in memory for 10 minutes, 404 when unknown |
| `GET /health`, `GET /ping`, `GET /v1/stats?days=N` | Open | Engine state and latency; stats as JSON (30-day default, bounded by retention) |
| `GET /models` | Open | Model catalogue |
| `GET /v1/engines`, `POST /v1/engine`, `/v1/engine/mode`, `/v1/engine/load`, `/v1/engine/unload`, `/v1/engine/lifecycle` | Control | Engine status, switching and lifecycle |
| `POST /v1/models/download`, `/v1/engines/validate`, `/v1/engines/discover`, `/v1/paths` | Control | Downloads, `flm validate`, discovery and tool paths |
| `GET /v1/policies` | Open | Policy list and variants |
| `POST /v1/policies/:id/mode`, `/variant`, `/thresholds`, `/v1/policies/reload` | Control | Policy settings, written to `config.yaml` |
| `GET /v1/policies/:id/prompt`, `GET /v1/config`, `POST /v1/config/reload`, `/v1/config/engine`, `/v1/routing/presets` | Control | Authoring prompt, config view and reload, engine connection and preset mapping |
| `POST /mcp` | Open | MCP over streamable HTTP with `decide` and `policies` tools; `local-decider mcp` is the stdio form. Policies with `mcp: false` (`permission`, `command-risk`) are refused and unlisted; `policies` shows only id, description, input keys, questions and options; `decide` is not read-only (it writes the log) and its confidence is calibrated only for engines that report it. MCP and CLI decisions are logged but excluded from stats, savings, calibration and precedent |

Security controls on these routes are in [security.md](security.md).
