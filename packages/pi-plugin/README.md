# @ziptie-soft/pi-local-decider

A [pi](https://github.com/earendil-works/pi) extension that puts a small **local decision model**
in front of pi's tool calls. pi runs every tool call without asking; this extension blocks
dangerous ones and, if you opt in, makes pi ask before the rest. It also lets pi scripts call the
gateway's model as a decision model.

> Unofficial. Not affiliated with pi, Strands Agents, AWS, AMD or FastFlowLM.

## Requirements

- pi. The extension's structural types were checked against **pi 1.6.1**; later versions may
  change the extension API.
- Node >= 24.15.
- The **local-decider gateway** running on the same machine. The extension is a thin client and
  never runs a model itself. Install the gateway first:
  [docs/install.md](https://github.com/ziptie-soft/local-decider/blob/master/docs/install.md).

## Install

Extensions are trusted, unsandboxed code, so read the source before you install.

```sh
pi install npm:@ziptie-soft/pi-local-decider
# try it for one run without adding it to settings
pi -e npm:@ziptie-soft/pi-local-decider
# from a checkout of this repository
pi -e ./packages/pi-plugin
```

The package ships TypeScript source and has no runtime dependencies, so no build step is needed.

## Modes

| Mode | Behaviour |
|---|---|
| `guard` (default) | pi keeps running tools without asking. The extension asks the gateway's `command-risk` policy within 1.5 s. It blocks a hard guard hit and an enforced `deny`, shows a dialog for an enforced `ask`, and lets everything else run, including every gateway failure. |
| `approve` | pi asks like Claude Code. The extension asks the `permission` policy within 10 s. A call runs without a dialog only when it is an enforced allow for a shell or edit tool on Linux or macOS, passes the deterministic and config guards, and the session has a task and recent user context. Anything else, including a gateway failure, shows the dialog. Without a UI, a call that needs a dialog is blocked. |
| `off` | The gate does nothing. |

Set the mode with the `--local-decider-mode` flag, then `LOCAL_DECIDER_PI_MODE`, then the default:

```sh
pi --local-decider-mode approve
LOCAL_DECIDER_PI_MODE=approve pi
```

An invalid value turns the gate off and shows a warning. The status line shows `ld: <mode>`, or
`ld: offline` when the gateway did not answer at startup.

The policies still follow their own `mode`: while `command-risk` or `permission` is in `shadow`,
the gateway logs decisions but does not enforce them, so only the deterministic guards act.
See [docs/policies.md](https://github.com/ziptie-soft/local-decider/blob/master/docs/policies.md).

### What is gated

pi's read-only built-ins and containers are exempt: `read`, `grep`, `find`, `ls`, `tool_search` and
`codemode`. The calls a `codemode` script makes are gated one by one. Every other tool is gated,
including MCP and unknown extension tools. Commands you type with `!` are not gated.

The dialog offers **Allow once** and **Block**. Escape, or no answer within 120 s, means Block.
There is no session-wide allow, because one approval would cover different edits. After a gateway
failure the gate skips the gateway for 30 s, so a down gateway does not add the timeout to every
call.

A call that touches local-decider's or pi's configuration always goes to the dialog and is never
auto-allowed. This covers the gateway config directory (`LOCAL_DECIDER_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/local-decider` or `~/.config/local-decider`), pi's agent directory
(`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and the project's `.pi` directory.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_DECIDER_PI_MODE` | `guard` | `off`, `guard` or `approve`; the flag wins |
| `LOCAL_DECIDER_URL` | `http://127.0.0.1:8765` | Gateway URL |
| `LOCAL_DECIDER_TOKEN` | none | Gateway control token, sent only to the gateway URL |
| `LOCAL_DECIDER_TIMEOUT_MS` | `1500` | Guard-mode gateway timeout, 1 to 10000 |

## Command

`/local-decider` shows the mode, gateway URL and health, and the last decision id.
`/local-decider mode <off|guard|approve>` overrides the mode until the session ends.

## Decision models

The extension registers the pi provider `local-decider` with one decision model, `active`: the
gateway's current engine. It needs no API key. Decision models are not in `/model`; scripts reach
them through the `codemode` tool, which you enable with `"defaultTools": ["+codemode"]` in pi's
settings:

```js
const model = await models.getModelOfType("classifier", "local-decider", "active");
const result = await models.classify(model, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

Extensions can call it with `ctx.modelRegistry.classify()`. Questions are `choice`, `score` or
`bool`; images are not supported and return an error result. The call never throws and uses a
30 s timeout, because the engine may be cold.

## Security limits

- Prompts and tool inputs are untrusted data. The extension never executes anything derived
  from them.
- `guard` mode fails open: a down or slow gateway lets the call run. `approve` mode is the
  one exception, because you chose it.
- Your answers in the dialog are reported to the gateway as unverified outcomes. pi has no
  sandbox, so a model could read the report token and forge allow evidence; unverified outcomes
  can only veto, never raise trust.
- Another extension's `tool_call` handler can change a call's input after this one runs, and pi
  does not revalidate it. Extensions are trusted code.
- The extension does not gate `read`, so it does not protect secrets that a model can read.

Design notes: ADR-0013.

## Maintainer notes

The `core/` directory holds verbatim copies of `packages/core` sources; a test keeps them
identical. `scripts/check-pi-pack.sh` checks the package contents and activates the packed
extension with a fake pi API. The first publish (0.1.0) is manual, to set up npm trusted
publishing; see
ADR-0009.
