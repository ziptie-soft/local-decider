# ADR-0013: pi coding agent extension

- **Status:** accepted
- **Date:** 2026-11-25

## Context

[pi](https://github.com/earendil-works/pi) runs every tool call without asking; it has no
permission system. Its extensions can handle a `tool_call` event before a tool runs and return
`{ block: true, reason }`. pi awaits each handler with no timeout, and an uncaught handler error
blocks the tool. Tools that a `codemode` script calls fire `tool_call` too, with
`parentToolCallId` and the id `<parent>/<n>`. Dialogs take `blockedKind: "permission"` (pi 1.6.1),
so terminals show the wait as a permission request.

pi also runs typed decision models (`models.classify()`, `ctx.modelRegistry.classify()`), which
take `{ state, questions }` with `choice`, `score` and `bool` questions: the same shape as the
gateway's `/v1/systemone`.

## Decision

Ship `packages/pi-plugin` as the npm pi package `@ziptie-soft/pi-local-decider`
(`"keywords": ["pi-package"]`, `"pi": { "extensions": [...] }`). It is a thin client of the
gateway. It ships TypeScript source, has no runtime dependencies, declares the pi API it uses as
local structural types, and vendors the pure core files it needs (checked byte for byte like the
Paseo plugin). Core gains the harness id `pi`.

### Tool-call gate

- Exempt only pi's read-only built-ins and containers: `read`, `grep`, `find`, `ls`,
  `tool_search`, `codemode`. The calls a `codemode` script makes are gated one by one. Every other
  tool is gated, including MCP and unknown extension tools.
- `guard` mode (default) keeps pi's run-by-default behaviour. It asks `command-risk` within
  1500 ms. An enforced `deny` or a hard guard hit blocks. An enforced `ask` or a guard hit marked
  `ask` shows the dialog. Anything else runs, including every gateway failure.
- `approve` mode (opt-in) makes pi ask like Claude Code. It asks `permission` within 10 s. A call
  runs without a dialog only when it is an enforced allow (`isEnforcedAllow`) for a shell or edit
  tool on a POSIX platform, it passes the deterministic and config guards, and the session has a
  task and recent user context. An enforced `deny` or a hard guard hit blocks. Anything else,
  including gateway failure, shows the dialog. Without a UI, a call that needs one is blocked.
  This is the one documented exception to failing open, because the user chose it.
- `off` disables the gate. The mode comes from `--local-decider-mode`, then
  `LOCAL_DECIDER_PI_MODE`, then `guard`. An invalid value disables the gate and says so.
- The dialog offers **Allow once** and **Block**. Escape or a dialog timeout (120 s; pi's RPC
  dialogs have none) means Block. There is no session-wide allow: canonical subjects omit edit
  contents, so one approval would cover different edits.
- After a gateway failure the gate skips the gateway for 30 s, so a down gateway does not add the
  timeout to every sibling call, because pi preflights them one after another.
- The gate runs the handler body in `try/catch` and fails open. It computes the result before
  any outcome report, so a failed report cannot turn a Block into a run.
- Call ids that do not match `CALL_ID` (nested `<parent>/<n>`) are sent as `pi-` plus a SHA-256
  prefix. Nested calls do not set `call.agent`.
- pi tool names are mapped to the shared vocabulary before the guards and `canonicalSubject` run:
  `bash` becomes `Bash`, `edit` becomes `Edit` and `write` becomes `Write`. PowerShell keeps its
  own name and is never auto-allowed.
- Human `!` commands (`user_bash`) are not gated: the user typed them.

### Outcomes

The dialog answer is reported to `/v1/outcomes` as source `user`, **without** the report token.
The gateway stores it as unverified. pi has no sandbox and does not gate `read`, so a model could
read the token and forge allow evidence. Unverified outcomes can only veto (ADR-0012). Verified
learning in pi needs a reporter that pi's tools cannot reach. Answers to guard prompts without a
decision id are not reported.

### Decision models

The extension registers the provider `local-decider` with one classifier model, `active`. It is
the gateway's current engine; `/models` is a catalogue, not a router. `classify()` calls
`/v1/systemone` and maps `bool` to `noul` and back. Images get an error result. It never throws:
every path returns a complete pi `ClassifierResult`. The provider needs no key; gateway
credentials come from the extension's config.

## Consequences

- pi users get the same risk gate as the other harnesses, and precedent keys match theirs.
- In pi, outcomes never raise trust. Precedent from other harnesses still applies in `approve`
  mode.
- Another extension's `tool_call` handler can change `event.input` after ours, and pi does not
  revalidate it. Extensions are trusted code; the gate does not defend against them.
- pi API changes reach us through the structural types in `extension/pi-types.ts`. Each type
  cites the pi source it mirrors, and the README names the pi version they were checked against.
