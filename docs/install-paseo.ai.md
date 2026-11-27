# Install local-decider for Paseo (guide for AI agents)

You are an agent installing local-decider for a user. Follow the steps in order and skip a step
whose check already passes. Commands are fish-compatible. Steps marked **Ask the user first** need
the user's explicit yes. If a step's check fails twice, stop and report the output to the user.

## 0. Check what is already installed

```sh
local-decider --version
local-decider gateway status
paseo plugin ls
```

## 1. Prerequisites

Node >= 24.15 and npm must be on `PATH`, and Paseo `>=0.15.3 <1.0.0` must be installed:

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

## 5. Install the Paseo plugin

Plugins are trusted, unsandboxed code. **Ask the user first.** Plugins must be enabled on the
daemon first: the user opens **Settings → Plugins → Enable plugins** in Paseo. Then:

```sh
paseo plugin install npm:@ziptie-soft/paseo-plugin-local-decider
paseo plugin ls
```

`local-decider` should show `running`. Upgrade later with `paseo plugin update local-decider`.
Details: [Paseo plugin README](../packages/paseo-plugin/README.md).

## 6. Verify

```sh
paseo plugin ls
local-decider gateway status
local-decider decide turn-outcome lastMessage="All tests pass; the PR is open."
local-decider stats
paseo plugin logs local-decider
```

`paseo plugin ls` shows `local-decider` as `running`. In Paseo, a decision row appears in the chat
after each agent turn. Engine and policy settings are in **Settings → Local decider**.

## 7. Troubleshooting

| Symptom | Likely cause | What to run |
|---|---|---|
| `local-decider` not listed or not `running` | Plugins disabled, or install failed | Enable plugins in **Settings → Plugins**, then `paseo plugin ls` and `paseo plugin logs local-decider` |
| Gateway not reachable | Gateway down or unusable | `local-decider gateway ensure --json`, then read the `listener` field (running, started, service-started, remote, port-busy, mismatch, stopped, unsafe-path, legacy, failed) |
| `listener` is `stopped` | A previous `gateway stop` request | `local-decider gateway start` |
| `listener` is `legacy` | An old gateway version is running | `local-decider gateway restart` |
| `listener` is `port-busy` | Another process holds the configured port (default 8765) | Free the port or change `port` in `config.yaml` (`local-decider config path`), then `local-decider gateway restart` |
| `listener` is `unsafe-path` | `~/.local/share/local-decider` is a symlink, not owned by you, or group/world-writable | Make it a real directory owned by the user, not group/world-writable. A symlinked data directory is unsupported |
| Decisions fail, engine down | Engine not installed or not loading | [setup-engines.ai.md](setup-engines.ai.md), then `local-decider gateway status` |
| Need logs | | `paseo plugin logs local-decider`, and `~/.local/share/local-decider/logs/` (`gateway.log`, `engine-<id>.log`) |

Clients reach the gateway over `~/.local/share/local-decider/run/gateway.sock` on Linux and macOS,
and over TCP 127.0.0.1:8765 on Windows or with an explicit `LOCAL_DECIDER_URL`.

## 8. Tell the user

Every policy starts in `shadow`: decisions are shown and logged, and nothing changes until the user
switches a policy to `act` (also in **Settings → Local decider**). Point them to
[install.md](install.md#your-first-week) ("Your first week").
