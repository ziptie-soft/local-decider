---
name: local-decider-settings
description: View or change local-decider settings (policy modes, the routing policy variant, which model each routing preset maps to for Paseo, Claude Code or Codex, engine lifecycle, tool paths, pricing, the model one decision uses). Use when the user asks to configure local-decider, turn a policy on, off or to act mode, switch routing policy, map routing presets to models, or give one decision its own model.
---

# local-decider settings

Start by checking the CLI exists: `command -v local-decider || echo missing`. If it is missing,
tell the user to install it (see the Quick start in the local-decider README) and stop.

Every local-decider setting lives in one YAML file that the gateway watches and applies as it
changes. Paseo's settings page writes to the same file.

1. Find it: `local-decider config path` prints `config.yaml`, the `schemas/` directory and the
   user `policies/` directory (usually under `~/.config/local-decider/`).
2. Read `schemas/config.schema.json` next to it before editing: every key has a description.
   Run `local-decider config schema` first if the directory is missing.
3. Prefer the commands, which validate before writing:
   - `local-decider policies` lists policies, their modes, routes and variants (gateway running).
   - `local-decider policies mode <policy> off|shadow|act`
   - `local-decider policies use routing <variant>` (e.g. `routing-budget`, `routing-task-kind`)
   - `local-decider routing` shows preset targets; `local-decider routing map <harness> <preset>
     <model> [--thinking <level>] [--mode <mode>]` and `local-decider routing unmap <harness>
     <preset>` change them. Harness ids are `paseo` (model as `provider/model`, plus optional
     `--mode <mode-id>` and `--profile <paseo-profile-id>`), `claude-code` (`haiku`, `sonnet`,
     `opus` or a full model id) and `codex` (a model id). `--thinking` sets a thinking or
     reasoning level such as `low`, `medium`, `high`, `xhigh` or `max`.
4. Or edit `config.yaml` directly, keeping its comments, then run `local-decider config check`.
   The keys are `policies.<id>.mode`, `policies.<id>.variant` and
   `routing.presets.<harness>.<preset>.model`/`.thinking`/`.mode`/`.profile` (`mode` and
   `profile` apply to Paseo only).
5. Engines, models and devices (and the `engines:` options map) are described in `docs/engines.md`
   in the local-decider repository; `local-decider engine list` shows what the gateway offers.
6. Changes to `host`, `port`, `engine` or `decisionTimeoutMs` need
   `local-decider gateway restart`; everything else applies within a second.
7. Keep `decisionTimeoutMs` below the hook budget. The Claude Code and Codex hooks time out at
   5 s (SessionStart at 3 s) in `hooks/hooks.json`, the hook client gives up after 1.5 s by
   default (`LOCAL_DECIDER_TIMEOUT_MS`) and sends the gateway a `budgetMs` of that minus 500 ms.
   The default `decisionTimeoutMs` of 30 000 ms mostly bounds queue wait and non-hook clients;
   never set `LOCAL_DECIDER_TIMEOUT_MS` to 5000 or more, or the harness kills the hook before
   it can fail open.

Policies ship in shadow mode. Confirm with the user before switching one to `act`, because
the hooks then change behaviour (auto-allowing permission requests, denying risky commands).
Claude Code and Codex cannot switch the session model from a hook: a mapped routing preset is
passed to the session as advice naming the model and, when mapped, the thinking level (the user
sets it with `/model` and the harness's effort or reasoning control).

## Model per decision

A decision can use its own engine and model instead of the default one. Details, limits and the
failure behaviour are in `docs/models.md` ("Switching the model for one decision").

- Config key: `policies.<id>.selection: { engine, model, device?, fallback? }`. The gateway
  applies an edit within a second, and a choice that cannot run becomes unavailable with a reason
  instead of stopping it. `fallback: default` (the default) lets the default model answer
  meanwhile; `fallback: open` skips the decision, never enforced.
- Commands, which check the choice first: `local-decider engine use <engine> <model> --policy <id>
  [--fallback default|open] [--device D]` and `local-decider engine use default --policy <id>`.
  `local-decider engine list` ends with a `Decisions:` block.
- Start the decision in `shadow`: its thresholds were set for the default model. Do not switch it
  to `act` without asking the user.
- Budgets: the default model and the own models that run locally share 80% of the machine's
  memory, and the default model wins. At most 3 different own models run at once (a model equal to
  the default, or a decision in mode `off`, takes no slot), and FastFlowLM runs one model in
  total. A decision in mode `off` loads nothing but keeps its memory.
