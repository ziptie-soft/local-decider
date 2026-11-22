# local-decider plugin for Claude Code and Codex

Hooks that send routine decisions to a local decision-model gateway: a deterministic command
guard, command-risk checks, permission triage, routing hints and turn-outcome logging. One plugin
directory serves both harnesses ([ADR-0004](../../docs/adr/0004-marketplace-layout.md)).

## Requirements

- Node.js 20 or newer for the hook processes. The hooks start through
  `hooks/local-decider-hook.sh`, which uses `node` from `PATH`, then
  `~/.local/share/mise/shims/node`, `/opt/homebrew/bin/node` and `/usr/local/bin/node`. On macOS
  a harness started from the Dock or Spotlight has a bare `PATH`, so a Homebrew or mise node is
  still found. When the launcher uses the mise shim it runs it from the plugin directory, so the
  shim picks your global node, not the one the project you are working in pins (which could
  download a node, or pick one older than 20, inside the hook's 3 s timeout). A node found on
  `PATH` runs in the harness's working directory as before. With no node at all the hook exits 0
  silently (fail open).
- For the auto-mode mod: Claude Code 2.1.304 or newer.
- A running `local-decider` gateway, by default at `http://127.0.0.1:8765`
  ([install](../../docs/install.md)). Without it the hooks run only the deterministic guard.

## Install

Claude Code:

```sh
claude plugin marketplace add ziptie-soft/local-decider
claude plugin install local-decider@ziptie-soft
```

Codex:

```sh
codex plugin marketplace add ziptie-soft/local-decider
codex plugin add local-decider@ziptie-soft
```

Then open the Codex TUI and run `/hooks` to review and trust the plugin hooks. Codex does not run
untrusted plugin hooks, and `codex exec` skips them silently. The approval covers every file in
the plugin, so **every plugin update needs a new `/hooks` review**: until you do, no hook runs.

Claude Code needs no trust step.

## What each hook does

| Event | Policy | Claude Code, when enforced | Codex, when enforced |
|---|---|---|---|
| `PreToolUse` | guard, then `command-risk` | deny or ask | deny only |
| `PermissionRequest` | `permission` | allow; otherwise the normal prompt | allow; otherwise the auto-reviewer or user |
| `UserPromptSubmit` | `routing` | add a hint naming the mapped model | same |
| `PostToolUse` | none (async) | report your approval of a prompt as an outcome | not installed |
| `Stop` | `turn-outcome` (async) | nothing: logged only | same |

## Enforcement by mode

What each path does when its policy is in `act`. In `shadow` every cell is "logged only".

| Path | Claude default or acceptEdits | Claude auto | Claude `-p` (no prompt) | Codex (user or `auto_review`) |
|---|---|---|---|---|
| Guard (`PreToolUse`, deterministic) | deny | deny | deny | deny |
| `command-risk` (`PreToolUse`) | deny or ask | deny; an ask forces a prompt and skips the classifier | deny; an ask is denied | deny only (ask dropped) |
| `permission` (`PermissionRequest`) | allow at a prompt, else the prompt | only for rule, hook or setting asks | allow, else denied | allow (pre-empts `auto_review`); managed checkpoints still need a person |
| `permission`, scope `claude-auto` (mod) | – | allows plain asks before the classifier | – | – |
| `routing` (`UserPromptSubmit`) | hint | hint | hint | hint |
| `turn-outcome` (`Stop`, `SubagentResult`) | logged | logged | logged | logged (no subagent result) |
| Approved-prompt outcome (`PostToolUse`) | reported | – | – | – |

Preconditions and limits:

- Codex runs nothing until `/hooks` trusts the hooks, again after every plugin update.
- Node 20 or newer on the harness's `PATH`, or one of the fallbacks under Requirements.
- Read, Glob, Grep, WebFetch, WebSearch and Agent are never checked: `PreToolUse` matches only
  `Bash`, the file-editing tools and `mcp__*` (Codex: `Bash`, `apply_patch`, `mcp__*`). A model
  check on every Read would cost about 1.5 s on CPU engines and, in auto mode, a hook `ask` would
  force a prompt past the classifier. A subagent's own tool calls pass through the parent
  session's hooks, so Agent is covered that way. Codex has no Read or WebFetch tool to hook (it
  reads through the shell), and its hosted web search cannot be hooked. A test pins the matchers.

Policies ship in `shadow` mode: the gateway records what it would have done and the hooks change
nothing until you switch a policy to `act`. The hooks never allow a tool call from `PreToolUse`
and never deny a permission request from the model.

In Claude Code, when you answer a permission prompt yourself (not in auto mode, and not one the
plugin allowed), the hook keeps the decision id in a pending file under
`~/.local/share/local-decider/hooks/pending/`. When the tool then runs, `PostToolUse` reports
outcome `allow` for it. These reports are unverified: they count toward labelled and agreement
stats but never update precedent, which still needs Paseo. Denials are not reported. A newer prompt
for the same tool call replaces the pending file, and pending files expire after 10 minutes. An
approval by another `PermissionRequest` hook is recorded as a user approval; such outcomes are
unverified.

The guard runs on shell commands before any gateway call, including Codex argv arrays,
`bash -lc` scripts and commands behind `sudo`, `env` or `nice`. It denies recursive deletes of
`/`, `~`, `$HOME` or system directories, deleting `.git`, `mkfs`, `dd` or redirects onto disk
devices, fork bombs, `chmod -R 777` on system paths, piping `curl` or `wget` into a shell,
force-pushing to `main` or `master`, and `shutdown` or `reboot`.

## Claude Code auto mode

In auto mode there is no prompt: a server-side classifier decides, and a hook `allow` does not
skip it. The plugin therefore also ships a mod (`hooks/local-decider-auto-mode.mjs`, listed
under `modules` in `hooks/hooks.json`; Codex does not read it) that asks the `permission` policy
first. When Claude Code would hand a plain, unremarkable `ask` to the classifier, the mod can
allow it instead. It never allows asks from rules, hooks or settings, outside auto mode, for
subagents, or for anything with a path outside the project, a protected path, `git push`,
publishing, network tools, `rm -r` or `sudo`.

**The mod never allows anything until you turn it on.** It ships with `scopes.claude-auto` in
`shadow`: it logs what it would have allowed and nothing else. Check
`local-decider stats --scope claude-auto`, then:

```sh
local-decider policies mode permission act --scope claude-auto
```

Needs Claude Code 2.1.304 or newer (older versions are skipped) and a running gateway. Set
`LOCAL_DECIDER_MOD=off` to switch it off. In act mode Claude Code shows the model a notice that
the plugin's hook "was skipped" on each allow, and in Paseo-launched sessions the allow is ignored
and the classifier decides. See [ADR-0007](../../docs/adr/0007-claude-auto-mode-mod.md).
The mod never needs or reads the gateway's `control-token` file.

`hooks/local-decider-auto-mode.mjs` is generated (not committed) from `packages/hooks/src/mod`
by the same build as `dist/local-decider-hook.mjs`. `mise run test:mod` validates it and runs
`claude plugin test`.

## Fail-open

If the gateway is down, slow or returns an error, or the hook itself fails, the hook prints
nothing and exits 0, so the harness behaves as if the plugin were not installed. The gateway call
has a 1500 ms budget; the hook timeout is 5 s.

## Configuration

Decision settings live in the gateway's `~/.config/local-decider/config.yaml`, shared with Paseo:

```sh
local-decider policies mode permission act
local-decider policies use routing routing-budget
local-decider routing map claude-code cheap haiku --thinking low
local-decider routing map codex premium gpt-5.5 --thinking high
```

Hooks cannot switch the session model, so the routing hint names the model and thinking level.
Claude Code can pass the model to subagents it starts, and you can switch with `/model`. See
[policies.md](../../docs/policies.md#routing-presets).

The plugin ships two skills: `local-decider-settings` (view and change settings) and
`local-decider-routing-policy` (interview you and write a routing policy for your models).

Environment variables read by the hook process and the mod:

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_DECIDER_URL` | `http://127.0.0.1:8765` | Gateway base URL |
| `LOCAL_DECIDER_TOKEN` | unset | Bearer token for a remote gateway; sent only over https or to loopback, never logged. Paired with `LOCAL_DECIDER_URL` (or the default URL), never with the `gateway_url` option |
| `LOCAL_DECIDER_TIMEOUT_MS` | `1500` | Gateway call budget |
| `LOCAL_DECIDER_MOD` | on | Set to `off` to disable the Claude Code auto-mode mod |
| `LOCAL_DECIDER_GUARD` | on | Set to `off` to disable the deterministic guard |
| `LOCAL_DECIDER_DEBUG` | unset | Set to `1` for diagnostics on stderr |
| `LOCAL_DECIDER_HOST_POLICIES` | unset | Comma list of policies a host runs itself; the hooks skip them |

Inside Paseo, the Paseo plugin sets `LOCAL_DECIDER_HOST_POLICIES=turn-outcome,permission,routing`
on the agents it launches, so there the hooks run only the guard and `command-risk`. The skip
also applies to a `claude -p` or `codex exec` the agent starts itself, since it inherits the
environment.

`dist/local-decider-hook.mjs` is generated from `packages/hooks` by
`pnpm --filter @ziptie-soft/local-decider-hooks build`. Do not edit it by hand. Neither generated
file is committed: the release workflow builds them and publishes this directory to npm as
`@ziptie-soft/local-decider-agent-plugin`, which both marketplaces install
([ADR-0009](../../docs/adr/0009-plugin-npm-distribution.md)). The `npm` CLI must be on `PATH`.

## Development

```sh
pnpm --filter @ziptie-soft/local-decider-hooks build
claude --plugin-dir plugins/local-decider
```

For Codex, point a personal `~/.agents/plugins/marketplace.json` at the checkout with
`{ "source": "local", "path": "<checkout>/plugins/local-decider" }`. Without a build the hooks
exit 0 silently.

Install end-to-end check, with no gateway, login or key (CI runs it as `e2e-install`):

```sh
mise run e2e:install   # or: mise run e2e:install codex
```

It packs the plugin, installs it from a local marketplace into Claude Code and Codex under a temp
`HOME`, and starts each harness against a stub gateway and a model API that answers 400. Both
harnesses run their first hooks before the first model call, so it checks that Codex runs nothing
until trusted and that routing reaches the gateway under both, and that a bare `PATH` falls back to
the mise shim, started from the plugin directory. It needs `claude` and `codex` on `PATH`
(`MISE_ENV=e2e mise install` installs the pinned versions).

End-to-end check against a running gateway, with a logged-in harness (it spends a few model
turns):

```sh
pnpm --filter @ziptie-soft/local-decider-hooks build   # Claude loads the checkout's bundle
mise run e2e:claude    # or e2e:claude-auto, e2e:codex, or e2e for all three
LD_E2E_USER_SETTINGS=1 mise run e2e:claude   # with your user settings and the installed plugin
```

Each run starts the harness headless in a scratch git repo under the temp directory and has it run
a fixed list of steps there. The steps include a file write, `rm -rf` and `chmod` inside the scratch
repo, one approval-requiring call and a `curl | sh` from a `.invalid` host. The run then reads that
session's records from the decision store. It passes when routing, `command-risk`, `permission`
(at least 3) and `turn-outcome` verdicts were all recorded and the guard denied `curl | sh`.

Claude runs with `--setting-sources project` and `--plugin-dir plugins/local-decider` (override
with `LD_E2E_PLUGIN_DIR`), so your own allow rules, sandbox auto-allow and hooks don't answer
permission requests before the plugin sees them. Managed settings still apply; the run warns when
they exist. `scripts/e2e-approve.mjs` is added through `--settings` as a second
`PermissionRequest` hook standing in for you: it denies `chmod` and allows everything else. The
run also checks that it decided at least 3 requests including a deny, and that `PostToolUse`
reported at least one outcome for the session's permission verdicts. With
`--permission-mode manual --permission-prompts none`, anything left undecided is denied instead
of waiting for you. Codex runs with `--approve-for-me` and `--dangerously-bypass-hook-trust`, so
the plugin hooks run without the `/hooks` trust step. `LD_E2E_KEEP=1` keeps the scratch repo, the
harness's event stream (hook events included) and the approver log.

`e2e:claude-auto` runs Claude in auto mode with no approver and an ask rule for `touch`. The
classifier decides every other call, so it passes when the plugin's `PermissionRequest` hook ran
exactly once (the `touch` step) and the mod recorded a `permission` decision in scope
`claude-auto`, next to the usual guard and `command-risk` checks. By default Codex runs against
the plugin installed in your Codex, so trust is not tested; with `OPENAI_API_KEY` set it installs
the checkout into a temp `CODEX_HOME` and logs in with that key (your `auth.json` is never
copied).

release-please bumps this package only for commits that touch `plugins/local-decider/`, so a
change to shared hook/core source or the dependency lockfile needs a change here too, to release
the rebuilt bundle.
