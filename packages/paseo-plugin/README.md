# @ziptie-soft/paseo-plugin-local-decider

A [Paseo](https://paseo.sh) plugin that uses a small **local decision model** for routine,
fixed-choice calls: did an agent's turn finish, get stuck, need you, or fail; can a tool
permission request be allowed; which model fits a new agent. Everything runs on your machine,
and every policy starts in **shadow mode**: decisions are shown and logged, and nothing changes
until you switch a policy to `act`.

> Unofficial. Not affiliated with Paseo, Strands Agents, AWS, AMD or FastFlowLM.

## Requirements

- Paseo `>=0.15.3 <0.17.0`, with plugins enabled on the daemon (**Settings → Plugins → Enable
  plugins**).
- The **local-decider gateway** running on the daemon machine. The plugin is a thin client and
  never runs a model itself. Install the gateway first:
  [docs/install.md](https://github.com/ziptie-soft/local-decider/blob/master/docs/install.md).

## Install

Plugins are trusted, unsandboxed code, so read the source before you install.

```sh
paseo plugin install npm:@ziptie-soft/paseo-plugin-local-decider
# or straight from GitHub, optionally pinned to a branch, tag or commit
paseo plugin install github:ziptie-soft/local-decider:packages/paseo-plugin --ref master
# or from a local checkout: the plugin directory, not the repository root
paseo plugin install (pwd)/local-decider/packages/paseo-plugin
```

The plugin imports only modules Paseo provides, so no install step or build is needed.

Run `paseo plugin ls` and check that `local-decider` shows `running`. Upgrade with
`paseo plugin update local-decider`; after pulling a local checkout, use
`paseo plugin reload local-decider`.

Then open **Settings → Local decider**. The **Engine and model** section has three blocks:
**Recommended for this machine** (the model family you use, on its fastest runtime),
**Benchmark this machine** (times every installed model and runtime; decisions are passed to you
while it runs, your setup comes back afterwards, and results are from this machine only) and
**Advanced: engine, device and model** (collapsed). Also choose each policy's mode and control
the gateway service. What each setting does, and how the recommendation is chosen:
[OVERVIEW.md](OVERVIEW.md). The engines come from the gateway; see
[docs/engines.md](https://github.com/ziptie-soft/local-decider/blob/master/docs/engines.md).

## Permissions and agent modes

The permission policy only sees requests that the agent's provider shows to Paseo as a prompt:

- **Always Ask (`default`) or Accept File Edits:** every tool prompt goes to the local model
  first. When it is confident, the request is allowed without asking you. Otherwise it stays
  pending for you. This is where the plugin saves time.
- **Auto mode:** the provider's hosted classifier reviews each action first, and the plugin only
  sees what it passes on. You save nothing over auto mode alone.
- **Bypass:** nothing is asked, so there is nothing to decide.

The plugin never denies a request. Parent agents can answer a child's pending request, and those
answers can become exact-match precedent: see
[supervised child agents](https://github.com/ziptie-soft/local-decider/blob/master/docs/supervised-subagents.md).

## Agent tools

Off by default; turn on **Agent tools (decide, explain)** under Advanced. Agents opened afterwards
get three tools through Paseo's own `paseo` MCP server, which Claude sees as
`mcp__paseo__local_decider_decide`, `mcp__paseo__local_decider_explain` and
`mcp__paseo__local_decider_policies`:

- `decide` asks a policy a question. The answer is advisory, never enforced, and recorded as a
  shadow decision (harness `mcp`, excluded from stats, calibration and precedent).
- `explain` reads why a decision came out as it did (loopback gateway and control token only).
- `policies` lists the policies agents may use.

Calls are rate limited per agent and overall. The plugin's own policy-writer agent never gets them.

Claude asks before the first call unless a rule allows it. With the setting on, the plugin allows
exactly these three names itself; or add to `permissions.allow`:
`mcp__paseo__local_decider_decide`, `mcp__paseo__local_decider_explain`,
`mcp__paseo__local_decider_policies`.

Caveats:

- Tools attach when an agent opens. After enabling the setting or reloading the plugin, earlier
  sessions get them only when reopened.
- They vanish when Paseo's tool injection is off (`daemon.mcp.injectIntoAgents: false`), when a
  provider has `paseoTools.enabled: false`, or when a tool is in `disabledTools`.
- Codex agents cannot use them yet: daemon 0.16.2 rejects the MCP protocol version `2026-07-28`
  that current Codex speaks. The plugin skips Codex approvals for the `paseo` server.
- The old `injectMcp` setting is migrated to this one.

## Privacy and what it runs

- Transcripts and tool requests go only to the gateway URL in settings (default
  `http://127.0.0.1:8765`). The gateway redacts secrets before the model sees them and logs
  hashes, never text.
- A bearer token (`LOCAL_DECIDER_TOKEN` in the daemon's environment, never stored in settings)
  is sent to loopback or to the HTTPS origin pinned by `LOCAL_DECIDER_TOKEN_ORIGIN` in that
  environment. The daemon reads the gateway's control and report token files from its config
  directory and re-reads them after a 401; agents never receive those tokens.
- Agent tools run inside the plugin: no gateway URL or token is written into any agent's config.
- The only processes the plugin starts are the gateway service commands behind the Start, Stop
  and Restart buttons. See [OVERVIEW.md](OVERVIEW.md#what-this-plugin-runs).

## Licence

Apache-2.0.
