# Install local-decider for Codex (guide for AI agents)

You are an agent installing local-decider for a user. Follow the steps in order and skip a step
whose check already passes. Commands are fish-compatible. Steps marked **Ask the user first** need
the user's explicit yes. If a step's check fails twice, stop and report the output to the user.

## 0. Check what is already installed

```sh
local-decider --version
local-decider gateway status
```

## 1. Prerequisites

Node >= 24.15 and npm must be on `PATH`:

```sh
node --version
npm --version
```

If Node is missing or older, suggest installing it with [mise](https://mise.jdx.dev)
(`mise use -g node`). **Ask the user first.**

## 2. Install the gateway

**Ask the user first** (global npm install):

```sh
npm install --global @ziptie-soft/local-decider
local-decider --help
```

Alternative: `LOCAL_DECIDER_AUTOINSTALL=1` lets plugins install the pinned gateway themselves. It
is opt-in; read the risk in [security.md](security.md) first.

## 3. Install an engine

Follow [setup-engines.ai.md](setup-engines.ai.md). Come back here when its final check passes.

## 4. Start the gateway

```sh
local-decider gateway start
local-decider gateway status
```

The plugin runs `local-decider gateway ensure` when the gateway is down. Set
`LOCAL_DECIDER_AUTOSTART=0` (or `off`, `false`) to disable that.

## 5. Install the Codex plugin

```sh
codex plugin marketplace add ziptie-soft/local-decider; and codex plugin add local-decider@ziptie-soft
```

The plugin installs from npm (`@ziptie-soft/local-decider-agent-plugin`), so `npm` must be on
`PATH`.

Codex runs plugin hooks only after they are trusted, and `codex exec` skips them silently. Tell the
user to open the Codex TUI and run `/hooks` to review and trust the plugin hooks. You cannot do
this for them. Every plugin update needs a new `/hooks` review; until then no hook runs. Details:
[plugin README](../plugins/local-decider/README.md).

## 6. Verify

```sh
local-decider gateway status
local-decider decide turn-outcome lastMessage="All tests pass; the PR is open."
local-decider stats
```

`decide` prints the answers, the action and `"enforced": false` (shadow). `stats` shows one block
per policy once Codex has sent decisions (only after `/hooks` trust); use Codex for a few minutes
and run it again.

## 7. Troubleshooting

| Symptom | Likely cause | What to run |
|---|---|---|
| No decisions appear in `stats` | Hooks not trusted, or run through `codex exec` | Open the Codex TUI and run `/hooks` |
| Hooks do nothing, gateway not reachable | Gateway down or unusable | `local-decider gateway ensure --json`, then read the `listener` field (running, started, service-started, remote, port-busy, mismatch, stopped, unsafe-path, legacy, failed) |
| `listener` is `stopped` | A previous `gateway stop` request | `local-decider gateway start` |
| `listener` is `legacy` | An old gateway version is running | `local-decider gateway restart` |
| `listener` is `port-busy` | Another process holds the configured port (default 8765) | Free the port or change `port` in `config.yaml` (`local-decider config path`), then `local-decider gateway restart` |
| `listener` is `unsafe-path` | `~/.local/share/local-decider` is a symlink, not owned by you, or group/world-writable | Make it a real directory owned by the user, not group/world-writable. A symlinked data directory is unsupported |
| Decisions fail, engine down | Engine not installed or not loading | [setup-engines.ai.md](setup-engines.ai.md), then `local-decider gateway status` |
| Need logs | | `~/.local/share/local-decider/logs/` (`gateway.log`, `engine-<id>.log`) |

If the gateway is unreachable the hooks fail open and only the deterministic guard runs. Clients
reach the gateway over `~/.local/share/local-decider/run/gateway.sock` on Linux and macOS, and over
TCP 127.0.0.1:8765 on Windows or with an explicit `LOCAL_DECIDER_URL`.

## 8. Tell the user

Every policy starts in `shadow`: decisions are logged and nothing changes until the user switches
a policy to `act`. Point them to [install.md](install.md#your-first-week) ("Your first week").
Remind them that Codex needs the `/hooks` trust step again after each plugin update.
