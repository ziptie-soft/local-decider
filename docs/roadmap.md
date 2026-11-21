# Roadmap

Date: 2026-11-12. Baseline: `master` at `fd1499e` (SQLite store merged).

This page collects what should change in local-decider and where it could go next. It was
written from a code review of every package, the git-ignored research notes under
`docs/research/` and `docs/review/` (referenced by name only), and a survey of other harnesses.

How to use it: each item is a self-contained brief for an architect or implementation agent.
Pick an item, read the cited files, and turn the **Direction** into a plan. Items are grouped by
theme, not by order; see [Suggested sequencing](#suggested-sequencing) for what to do first.

Priorities:

- **P0**: correctness or security, do now. An attacker, a bug or a bad release can make the
  decider act when it should not.
- **P1**: next. Robustness, feedback loop, integration gaps that block the product's promise.
- **P2**: later. Polish, hygiene, docs, lower-risk debt.
- **P3**: exploratory. Needs a spike or a measurement before committing.

Sizes: **S** under a day, **M** a few days, **L** a week or more.

Every direction below keeps the repo's security rules: never execute anything derived from a
prompt or tool input; bind to loopback by default; redact before anything reaches an engine or
the log; hooks fail open; and no label, power or scheduling path may produce `allow` without a
verified, thresholded answer.

## Improvements

### Security and trust boundary

### S1 Key-aware deep redaction and rule hardening

- **Priority:** P0. **Size:** M.
- **Problem:** `redactDeep` redacts each string alone with no key context
  (`packages/core/src/redact.ts:76-88`), so `{password: 'hunter2'}` or `headers.authorization`
  pass through to the engine. The assignment rule stops at the first space or quote
  (`redact.ts:38`), URL credentials are cut at `/` and `@` (`:32`), `Basic` matches prose
  (`:29`), `max_tokens` is redacted, and Stripe/SendGrid/HF shapes are missing (`:17-28`).
- **Direction:** redact values whose key matches the secret-name pattern (and the key itself);
  handle quoted values and `--token X` / `-p X` CLI forms; take URL passwords to the last `@`;
  require a base64-like token for `Basic`; add provider shapes with one test each; skip values
  already labelled `[REDACTED:`; add depth and cycle guards. Touches `core/redact.ts` and tests.
- **Open questions:** should redaction report a "low confidence" flag when it hits an unusual
  shape, so the gateway can refuse to log the subject hash? How much latency is acceptable?

### S2 Allow rules need thresholds; raise the allow floor

- **Priority:** P0. **Size:** S.
- **Problem:** The rule schema accepts an `allow` rule with neither `minConfidence` nor
  `minProbability`, and `default: allow` (`packages/core/src/policy.ts:83-105,150-154`).
  `ALLOW_THRESHOLD_FLOOR = 0.5` only clamps config overrides (`:301`), and 0.5 is a plurality,
  not confidence, for three-option questions (`policies/permission.yaml:37-40`).
- **Direction:** `superRefine` the policy: a non-precedent `allow` rule needs a threshold at or
  above the floor; `default` may never be `allow`; raise the floor (0.8 proposed) or require
  precedent below 0.9. Constrain `precedent` rules to `allow`/`ask`. Document in
  `docs/policies.md`. Touches `core/policy.ts`, `schemas/`, `policies/*.yaml`.
- **Open questions:** does any shipped or user policy rely on a bare allow? Should the floor be
  per question type (noul vs choice)?

### S3 Reject unusable engine answers

- **Priority:** P0. **Size:** S.
- **Problem:** A score answer whose probabilities are missing or keyed by label normalises to all
  zeros and `scoreConfidence` returns 1 (`packages/core/src/systemone.ts:109-118,146-157`).
  Choice confidence is derived from p_max, not the reported answer, and `wire.choice` is not
  validated against the criteria (`:134-143`). `usable` only checks that `probabilities` is an
  object, so NaN or negative values reach argmax (`:164-172`). A confident first-level answer
  can drive an `allow` rule.
- **Direction:** `usable` must require finite probabilities over the known option ids summing to
  about 1; take argmax always and compute confidence from it; treat empty or single-option maps
  as unusable; document the noul tie. Add malformed-wire tests. Touches `core/systemone.ts`.
- **Open questions:** which engines emit label-keyed probabilities today (FastFlowLM, openai
  path)? Should a dropped answer surface as `error` in the decision record?

### S4 A control token for the loopback gateway

- **Priority:** P0. **Size:** M.
- **Problem:** Without `LOCAL_DECIDER_TOKEN` (the default) every route is open to any local
  process; `browserGuard` only stops browsers (`packages/gateway/src/server.ts:258-266,292-308`).
  `pathsEditable: !hasToken` (`runtime.ts:77`) means engine switching, `POST /v1/paths`,
  `/v1/engines/validate` and `saveEngineConnection` (`engine-control.ts:610-628`, writes `url`
  and `tokenEnv`) are open exactly when there is no token. A local process could point the
  gateway at an https URL and have it send redacted state plus a bearer from any env var.
- **Direction:** auto-generate a 0600 control token at first start (like `report-token`),
  require it on control and config routes, and have the CLI and Paseo plugin read it from the
  data dir. Decide routes stay open on loopback. Keep `/v1/usage` and `/v1/outcomes` on the
  report token. Touches `server.ts`, `runtime.ts`, `report-token.ts`, CLI, Paseo `deps.ts`.
- **Open questions:** one token or two scopes (report vs control)? How does the Claude Code mod,
  which runs in a different process, obtain it, if at all?

### S5 Paseo plugin token scoping

- **Priority:** P0. **Size:** S.
- **Problem:** `createGateway` sends both `LOCAL_DECIDER_TOKEN` and the local `report-token` to
  any `gatewayUrl` that passes `tokenAllowed` (https or loopback)
  (`packages/paseo-plugin/shared/gateway.ts:190-191`). `gatewayUrl` is a non-secret,
  host-scoped setting. No `redirect: 'error'` on fetch. With `injectMcp` the daemon bearer is
  copied into each agent's MCP headers (`server/mcp.ts:13-15`, `open.ts:22-28`), readable by an
  untrusted-prompt agent.
- **Direction:** report token loopback-only; bearer only to an origin pinned by env
  (`LOCAL_DECIDER_TOKEN_ORIGIN`) or loopback; `redirect: 'error'` everywhere a token is sent
  (also `core/client.ts:124`); mint a scoped MCP token or send none on loopback. Add tests that
  the report token is withheld from https and redirects are refused.
- **Open questions:** does Paseo expose a per-agent secret channel that avoids writing tokens
  into MCP config at all?

### S6 Harden outcome and usage ingestion

- **Priority:** P1. **Size:** S.
- **Status:** done (2026-11-21) — usage gated by report token and tagged verified; unknown ids
  404; outcome whitelist; unverified rate limit and 30-day prune; stats count unverified apart.
  Claude Code hook outcomes have no report token, so they stay unverified and show only in the
  `unverified` counts; a per-harness verified channel is future work.
- **Problem:** `POST /v1/usage` is not gated by the report token and `decisionId` is not checked
  (`packages/gateway/src/server.ts:542-547`). Unverified outcomes are stored without cap or rate
  limit (`:548-558`, `sqlite-log.ts:279-290`), outcome values are free strings, and orphans
  survive the whole retention window. Savings and agreement stats can be forged.
- **Direction:** reject unknown decision ids; whitelist outcome values (see Q1); tag usage rows
  `verified`; rate-limit unverified posts; drop orphans at prune. Planned in:
  `docs/research/scaling-plan.md` (phase 1.1).
- **Open questions:** should unverified rows be excluded from agreement stats too, or shown
  separately?

### S7 Deterministic guard coverage and bypasses

- **Priority:** P1. **Size:** M.
- **Status:** done (2026-11-21) — more guard rules, size tiers, write guard, shared core
  checks; Paseo skips auto-allow on flagged calls.
- **Problem:** Stdin over 4 MiB returns `''` and skips the guard entirely
  (`packages/hooks/src/main.ts:8,16-17`), so a huge Write bypasses it. Guard rules miss
  `git reset --hard`, `git clean -fdx`, `find -delete`, `xargs rm`, `push --delete`,
  `python -c`/`node -e` deletes; only `-c` shells are unwrapped (`guard.ts:648`). The `rm .git`
  rule fires inside heredocs and quoted strings (`guard.ts:583`); `curl | sh` is a hard deny
  while the fixture expects `ask` (`guard.ts:681-690`).
- **Direction:** guard on a truncated prefix or the `command` field only; add a small
  conservative rule set; ignore quoted and heredoc bodies; decide and document the
  `curl | sh` policy. Add bypass tests (`env rm`, `command rm`, nested `bash -c`, `"$HOME"`).
- **Open questions:** should hard denies be user-overridable per project, or only via
  `LOCAL_DECIDER_GUARD=off`?

### Robustness and fail-open

### R1 Queue admission: dead waiters, priority, hard deadline

- **Priority:** P0. **Size:** M.
- **Problem:** Aborted waiters stay in `#waiting` and count toward `depth`
  (`packages/gateway/src/queue.ts:22-41`); the `QUEUE_MAX` check ignores priority
  (`decider.ts:480`). One 30 s job plus a burst of low turn-outcome jobs refuses every
  permission or command-risk request with "engine queue full". Shadow jobs ignore caller abort
  by design (`decider.ts:394`) and compete in the same serial queue. If the engine ignores
  abort, `#busy` stays true forever (`decider.ts:483-489`). `ensureReady` runs inside the slot
  (`lazy.ts:97-118`), so a cold engine holds it for the whole timeout.
- **Direction:** remove aborted entries on `signal`; per-priority admission (reserve slots for
  `high`, evict the oldest `low` waiter); shadow jobs run at `low` with a cap; race the job
  against the deadline and release the slot; wait for readiness outside the serial section;
  coalesce identical in-flight hashes. Add a dedicated `SerialQueue` test. Planned in:
  `docs/research/scaling-plan.md` (phase 2.1, `budgetMs`).
- **Open questions:** should adapters send `budgetMs` so the gateway can refuse early instead of
  letting the hook time out?

### R2 Engine supervision: crash, hang and restart

- **Priority:** P1. **Size:** M.
- **Status:** done (2026-11-21) — `#fail` kills the child, `start()` is idempotent with a
  generation counter and a 60 s failed cooldown, the restart path is caught, a `/health` probe
  after 3 decision timeouts restarts a hung engine, process guards log rejections and exit on an
  uncaught exception, remote and openai retries are bounded (`engines/retry.ts`).
- **Problem:** When the engine never becomes healthy the state is `failed` but the child is not
  killed (`packages/gateway/src/engines/supervised.ts`, `#fail`), and `ManagedEngine.load()`
  restarts on every call (`lazy.ts`), so each decision spawns another child. The restart
  timer has no catch and there are no process-level handlers. A hung
  but alive engine stays `ready` and every decision waits the full timeout. `remote.ts`
  sets `failed` on any error.
- **Direction:** kill the child in `#fail`; idempotent `start()` with a generation counter;
  catch the restart path; an `unhandledRejection` logger; an active `/health` probe after N
  consecutive timeouts that flips state and restarts; bounded retry for remote engines. Add
  `SupervisedEngine` tests (crash budget, restart race, failed-with-live-child, hang).
- **Open questions:** resolved: no fallback outside `auto`; a hang restarts first and falls back
  in `auto` only after the restart budget runs out.

### R3 Pass-through routes under the same admission

- **Priority:** P1. **Size:** S.
- **Problem:** `/v1/systemone` and `/invocations` bypass `QUEUE_MAX`, run at `normal`, are never
  cached or logged, and skip the failure/success handlers (`decider.ts:339-346`), so any caller
  can queue unbounded work ahead of `low` jobs and auto-fallback never learns about errors.
- **Direction:** apply the same cap and priority (default `low`), report engine failures, and
  count them in health.
- **Open questions:** should pass-through be disabled unless a control token is present (S4)?
  Decided: not now; revisit with S4.
- **Status:** done. Pass-through takes the `QUEUE_MAX` admission at priority `low` (full queue
  or engine 503 answers 503) and reports failures and successes to the engine handlers. It
  stays uncached and unlogged and carries no `budgetMs`.

### R4 SQLite off the hot path

- **Priority:** P1. **Size:** M.
- **Problem:** `DatabaseSync` with `busy_timeout=2000` blocks the event loop up to 2 s per
  append when prune, VACUUM, a stats reader or a CLI writer holds the lock
  (`packages/gateway/src/sqlite-log.ts:338,359-360`). Prune and `incremental_vacuum` run on the
  main thread (`:132-161`); a full `VACUUM` at startup aborts the gateway on failure (`:369-374`);
  `JSON.parse` per row has no guard and a bad row stops startup (`:583`); `readRecent` loads the
  whole window into memory (`:219-233`); `queue_ms`, `engine_ms`, `power` are never populated
  (`:269-272`).
- **Direction:** queue appends and flush off the hot path (or a writer worker); chunked deletes;
  log and continue on vacuum failure; guard per row; aggregate stats in SQL; record queue and
  engine time. Back up before migrating; clear message on a newer `user_version`.
- **Open questions:** worker thread for writes, or accept a small async queue with a bounded
  loss window on crash?

### R5 Observability and error hygiene

- **Priority:** P1. **Size:** S.
- **Problem:** `/health` has only p50/p95 and `queueDepth` (`server.ts:321-342`); no counters
  for queue-full refusals, timeouts, error decisions, DB write failures or engine restarts. The
  latency window excludes failures (`decider.ts:494`). Unknown errors return `error.message`
  as 502, which can echo engine output containing state (`server.ts:619`); the engine log filter
  is an unredacted substring match (`engines/log-filter.ts:7-9`).
- **Direction:** add counters to `/health` (or `GET /metrics`), track error latency separately,
  return a generic 502 body and log detail server-side, run `redactDeep` on engine log lines.
- **Open questions:** Prometheus text format or JSON only?

### R6 Hook runner budgets and client hardening

- **Priority:** P1. **Size:** S.
- **Problem:** `LOCAL_DECIDER_TIMEOUT_MS` is unbounded (`packages/hooks/src/run.ts:56-59`);
  `Stop` is synchronous and waits up to 1.5 s for a log-only policy (`hooks.json:43-53`); the
  mod's two 1.5 s budgets run sequentially and `$.http.fetch` never aborts
  (`mod/register.ts:106,129`, `mod/gateway.ts:384-387`); the sh wrapper probes only the mise
  shim (`local-decider-hook.sh:11`) and fails silently. `DecideResponse` is cast, not validated
  (`core/client.ts:107`), so a misbehaving gateway can crash an adapter.
- **Direction:** clamp the timeout below the harness timeout; fire-and-forget for `Stop`; one
  shared deadline in the mod; probe volta/fnm/asdf/`~/.local/bin` and print a
  `LOCAL_DECIDER_DEBUG` line; a minimal response guard in the client. Planned in:
  `docs/research/claude-codex-hooks.md` (fail-open recipe).
- **Open questions:** does Claude Code support async hooks for `Stop`?

### R7 Paseo plugin robustness

- **Priority:** P1. **Size:** M.
- **Problem:** When the gateway returns null or the mode is off the permission handler returns
  early and never clears `pending` (`packages/paseo-plugin/server/permission.ts:120-139`);
  `tryAllow` swallows every error as "already resolved" (`:254-258`); the routing hook gives
  `decide` the full 2 s again instead of the remainder (`routing.ts:65-71,209-212`) and only UI
  polling marks the gateway down (`index.server.ts:125,162`); a Paseo `failed` turn is still
  sent to the model (`turn.ts:71-73`); `pending`, `usage` links and `seen` are in-memory and lost
  on restart (`permission.ts:80-81`, `usage.ts:5`, `turn.ts:48`).
- **Direction:** clean `pending` on every exit; log and classify `tryAllow` errors; pass the
  remaining budget; mark down on timeout or `ECONNREFUSED` in the hook; deterministic `failed`
  row; persist usage links in the gateway keyed by agent id. Planned in:
  `docs/research/paseo-plugin-api.md`.
- **Open questions:** does Paseo replay `permission.before` after a daemon restart?

### R8 Server, shutdown and lock hardening

- **Priority:** P2. **Size:** S.
- **Problem:** No `headersTimeout`/`requestTimeout` on `createServer` (`server.ts:633`);
  `gateway.close()` has no timeout or catch (`runtime.ts:116-125`); the pid lock relies on pid
  liveness only (`sqlite-log.ts:457-498`); sync throws inside `route()` escape the listener
  (`server.ts:653`); an empty `report-token` file yields `''` (`report-token.ts:10-31`).
- **Direction:** set timeouts; `.finally(exit)` plus a hard timer; `flock` or a start-time check;
  wrap the listener; regenerate an empty token.
- **Open questions:** none.

### R9 Cache and hash correctness

- **Priority:** P2. **Size:** S.
- **Problem:** The decision cache key omits engine and model (`decider.ts:391`); the same
  `inputHash` serves the precedent key with a different shape and no domain tag (`:451`); a
  missing `project` makes precedent apply across projects; `canonicalJson(undefined)` returns
  undefined (`core/canonical.ts:19-21`) and `subject.ts:107` papers over it; the cache is FIFO.
- **Direction:** add engine and model to the key (or clear on switch, verify), prefix domain
  tags, require `project` for precedent, make `canonicalJson` total, LRU eviction.
- **Open questions:** none.

### Decision quality and feedback loop

### Q1 Typed outcome labels and permission-row feedback

- **Priority:** P0. **Size:** M.
- **Problem:** A user's decline is reported as `deny` whatever the reason
  (`packages/paseo-plugin/server/permission.ts:168-200`), and any verified deny vetoes
  precedent (`gateway/src/precedent.ts:76-96`, `decider.ts:456`) and counts as an unsafe sample
  in calibration (`stats.ts:154-195`). Permission rows have no feedback control
  (`client/decision-row.tsx:117-120`). "Off-task" declines pollute precedent and skew threshold
  hints. No research note covers this.
- **Direction:** add outcome values `decline`, `interrupted`, `unsafe` to the gateway schema;
  ignore `decline`/`interrupted` for precedent and calibration; after a deny show chips "Not a
  safety issue / Unsafe / Skip"; add a "Stop auto-allowing this" action on auto-allowed rows
  that writes a veto label. Until the schema lands, do not report ambiguous declines as `deny`.
  Labels never produce `allow`; they only lower or remove precedent.
- **Open questions:** should an unlabelled decline default to `decline` (neutral) or `deny`
  (conservative)? How long should the chips stay actionable?

### Q2 Hook outcomes from PostToolUse and PermissionDenied

- **Priority:** P1. **Size:** M.
- **Problem:** Claude and Codex hooks use four events (`plugins/local-decider/hooks/hooks.json:
  5-54`), none after the decision; `command-risk` can never learn and the dialog answer is never
  reported (`packages/hooks/src/run.ts:104-122`, `output.ts:503`). `callOf` exists only for
  Claude PreToolUse (`mapping.ts:349-355`), so Codex calls never join by id.
- **Direction:** add `PostToolUse` (and `PermissionDenied` on Claude) adapters keyed by
  `tool_use_id`; `ask` followed by `PostToolUse` means the user approved; post to
  `/v1/outcomes` with the report token (S6) as source `user`. Pass `call.id` for Codex when the
  payload carries one. Fail open as today.
- **Open questions:** does Codex emit a usable post-tool event with the same id? How reliable is
  the pairing for parallel tool calls?

### Q3 Richer permission and command-risk input

- **Priority:** P1. **Size:** M.
- **Problem:** For Write/Edit/MCP the hook sends the whole raw `tool_input` as `command`
  (`packages/hooks/src/mapping.ts:313-318`); only `cwd` reaches the policy, no worktree or
  git-root signal (`permission-input.ts:10-13`); the mod's `insideCwd` (`mod/check.ts:189-194`)
  is unused by the hook runner; the mod registers only Bash/Edit/Write (`mod/register.ts:174-175`)
  so MCP calls always fall to the classifier. Known false positives: whole-file Write, `sed -i`,
  python heredocs, `mise run`, fff/mise MCP calls, all inside the agent's worktree. Permission
  input builders are duplicated (`paseo-plugin/server/history.ts:252-275`,
  `hooks/src/permission-input.ts:26-35`, `mod/input.ts:468-478`).
- **Direction:** one core `buildPermissionInput` with limits (subject, capped content, path);
  input keys `inCwd`, `gitRoot`, derived hints (interpreter heredoc, in-place edit, mise task);
  read them in `policies/*.yaml`; allow-list read-only MCP tools in the mod. Export the
  `CALL_ID` regex from core.
- **Open questions:** which derived hints move the needle on the 2B model? Measure with fixtures
  (Q5) before shipping.

### Q4 Policy criteria tuning

- **Priority:** P1. **Size:** S.
- **Problem:** `permission.yaml:28-40` lacks examples for `git branch <name>`, `switch -c`,
  `stash`, `add`, `restore <file>`, `mkdir`/`mv` in project, so `git branch backup-x` asks.
  Neither `permission.yaml:31-35` nor `command-risk.yaml:22-24` names "downloads and executes
  remote code". `rm -rf dist` in the worktree may hit "deletes data irreversibly". `branch -d`,
  `branch -m`, `push --delete` are not in the ask list. `routing-budget.yaml:39` defaults to
  `route:cheap` when uncertain.
- **Direction:** add the named examples to allow and ask; a remote-code-exec criterion in
  permission deny and command-risk dangerous; a safe carve-out for build and cache output inside
  the project; `abstain` as the budget default (or document). Re-check with fixtures.
- **Open questions:** criterion wording is model-sensitive; which model is the reference?

### Q5 Per-policy fixtures and an eval regression gate

- **Priority:** P1. **Size:** M.
- **Problem:** Only `permission` has fixtures (20 cases, skewed to ask); `policies eval` never
  fails (`packages/gateway/src/eval.ts:36-49`); `test/eval.test.ts:37-53` hardcodes the first
  10 expectations by position. Documented results (`docs/benchmarks.md:44-46`) have no fixture.
  Calibration hints come from escalated decisions only (selection bias, `stats.ts:195`).
- **Direction:** JSONL fixtures for command-risk, turn-outcome, routing variants, with tags;
  `policies eval --strict` exits non-zero below a per-class pass rate; assert by tag in tests; a
  manual or nightly job with a pinned engine and model; document the hint bias or require a
  holdout. The gate is the precondition for future learning features (F5).
- **Open questions:** which engine is cheap enough to pin in CI (openai-compatible CPU model,
  or a recorded-response fixture)?

### Q6 Truncation markers and budget

- **Priority:** P2. **Size:** S.
- **Problem:** When the budget runs out earlier sections are dropped silently
  (`packages/core/src/truncate.ts:53-62`); `cutText` returns a marker longer than `maxChars`
  (`:25-40`); 4 chars/token is optimistic for JSON and paths (`:16,51`); slices can split a
  surrogate pair.
- **Direction:** emit `[N sections omitted]`, clamp the marker, default to 3 chars/token or a
  per-content estimator, cut on code points.
- **Open questions:** verify the estimate against the real tokenizers of the shipped models.

### Q7 Policy loader strictness

- **Priority:** P2. **Size:** S.
- **Problem:** Two rules with the same `<question>.<answer>` key both receive a config override
  but only the first is listed (`core/policy.ts:358-392`); `answer: true` fails with a generic
  message (`:187-192`); no file loader enforces `id` equals filename (`:214-230`); harness ids
  are not an enum (`:134`); `Action = string`.
- **Direction:** validate unique threshold keys, coerce scalar answers, add `loadPolicyFile`
  with id and duplicate checks, `z.enum(HARNESSES)`, a template-literal `Action` type.
- **Open questions:** none.

### Harness integrations

### H1 Paseo: explain, see and override decisions

- **Priority:** P1. **Size:** M.
- **Problem:** Rows show a one-line summary (`packages/paseo-plugin/client/decision-row.tsx:
  127-135`), no probabilities, threshold or matched precedent; routing decisions leave no row
  (`server/routing.ts:247`); `notify` is only a row note, no badge (`turn.ts:104-130`); "plugin
  act but gateway shadow" is invisible (`turn.ts:29-31`); no "deciding..." row while a 60 s
  permission decide runs (`permission.ts:35`); detached work over 16 in flight is skipped silently
  (`background.ts:52-54`).
- **Direction:** tap-to-expand with probabilities, threshold and precedent; a routing row on
  `agent.create.after`; a sidebar badge from rows; a status warning when the gateway does not
  enforce; a pending row; a "skipped: busy" row in act mode. Reuse the gateway's decision record,
  no new state text.
- **Open questions:** Paseo timeline rows are in-memory with a 64 KiB cap; is that enough?

### H2 Paseo: routing overrides, loop guards, supervised deadlines

- **Priority:** P1. **Size:** M.
- **Problem:** `applyRouteTarget` overrides an explicit `model` and provider set by the creator;
  only `modeId` is guarded (`server/routing.ts:239-246`). Turn and permission handlers never
  check `internal` or plugin-created agents (`turn.ts:64-90`, `permission.ts:113-123`); the
  permission path has no rate limit. `docs/supervised-subagents.md:56-62` tells orchestrators to
  wait 15 s while the plugin's decide deadline is 60 s, so parents race the decider.
- **Direction:** skip routing (or shadow) when a non-user creator set the model; skip `internal`
  agents and tag agents created via the injected MCP; a global rate limit; cap the permission
  decide at about 10 s and align the doc. Routing never raises a permission mode (allow-list
  only). Planned in: `docs/research/paseo-profile-routing.md` (mode escalation risk).
- **Open questions:** does Paseo mark the creator of an agent?

### H3 Codex and Claude Code end-to-end parity

- **Priority:** P1. **Size:** S.
- **Problem:** Unverified: Codex runs hooks from marketplace-installed plugins, sets
  `CLAUDE_PLUGIN_ROOT` (`plugins/local-decider/hooks/codex-hooks.json:10`), and whether mise
  node shims resolve inside hook processes. Claude `PermissionRequest` may not fire in auto mode.
  Codex is deny-only for `PreToolUse` and has no mod equivalent; the README does not spell out
  the per-harness enforcement table. Claude's matcher omits Read/WebFetch/Task.
- **Direction:** a scripted e2e run per harness (recorded in `docs/demos.md`); resolve the
  plugin root relative to the script; document the enforcement matrix in the plugin README;
  decide whether Read/WebFetch/Task should be risk-checked. Planned in:
  `docs/research/claude-codex-hooks.md`.
- **Open questions:** does Codex re-trust hooks after every release (hash-based trust)?

### Install, release and CI

### I1 Gate npm publish on CI

- **Priority:** P0. **Size:** S.
- **Problem:** `publish` needs only `release-please` (`.github/workflows/release.yml:37-38`) and
  runs build, pack check and publish (`:56-63`) with no tests, typecheck or lint. A master commit
  that fails CI can still publish. `pnpm -r publish` relies on registry skip behaviour that is
  unverified.
- **Direction:** run `pnpm -r test` and typecheck in the publish job, or wait for the CI run of
  the same SHA (`workflow_run` or a check-runs query); publish only the components release-please
  released with `--filter`. Keep SHA-pinned actions, minimal permissions, `timeout-minutes`.
- **Open questions:** does release-please expose the released package list as an output?

### I2 CI coverage: plugin validate, schema drift, bundles

- **Priority:** P1. **Size:** S.
- **Problem:** `test:mod` (`claude plugin validate --strict`) is skipped when `claude` is absent
  and is not in `check` or `ci.yml` (`mise.toml:114-118,95`); the `schemas` script has no drift
  check (`packages/gateway/package.json:57`); `dist/local-decider-hook.mjs` and the mod bundle
  are committed (`packages/hooks/build.mjs:10,36`) with no rebuild-diff step verified.
- **Direction:** install `claude` in the static job or fail loudly; `git diff --exit-code` after
  schema generation and bundle build; confirm `test:integration` has a manual runbook.
- **Open questions:** none.

### I3 Install and CLI accuracy

- **Priority:** P1. **Size:** S.
- **Problem:** `--no-download` still runs `uv sync --frozen` (`docs/install.md:51` vs
  `packages/gateway/src/engine-install.ts:37`); git is an undocumented requirement
  (`engines/strands-decider/pyproject.toml:11,17`); the service unit bakes `process.execPath`
  (`service.ts:12-14`) and goes stale after a Node upgrade; `policies` and the MCP backend call
  `/v1/policies` without the token or an `ok` check (`cli.ts:423-427,486-491`); `flm` steps use
  `execFileSync` without a catch (`cli.ts:171-173`); no `--version`; invalid `--input` JSON is a
  raw `SyntaxError`.
- **Direction:** fix the docs; `gateway status` checks `ExecStart` exists; one authed fetch
  helper; named errors for `flm` steps; `--version` from `package.json`; `UsageError` for input.
- **Open questions:** a real offline install mode (vendored wheels) is a separate P3 spike.

### I4 Plugin distribution and Paseo publish readiness

- **Priority:** P2. **Size:** M.
- **Problem:** The Paseo package ships TS sources with `workspace:*` deps
  (`packages/paseo-plugin/package.json:23-48`); no tarball-install test; no icon or screenshots
  in the manifest; dev deps pin 0.15.3 while the requirement allows `<0.17.0`. The Claude/Codex
  plugin's npm distribution (ADR-0009) has open risks: first publish 2FA, pins before publish,
  hooks-only changes not bumping the plugin.
- **Direction:** `npm pack` install test in a clean plugin dir; manifest assets; a CI matrix
  against 0.16.x; finish the ADR-0009 release-please wiring. Planned in:
  `docs/research/plugin-npm-distribution-plan.md`, `docs/review/paseo-plugin-publish-review.md`.
- **Open questions:** is the gateway package reachable for registry users without the
  monorepo?

### Docs and DX

### D1 Docs that disagree with code

- **Priority:** P1. **Size:** S.
- **Problem:** `README.md:86` says 30-day retention, code defaults to 365 (`config.ts:198-200`);
  `docs/architecture.md:93` says "at most 8 waiting", actual is 7 waiting plus 1 running;
  the routing "~2 s budget" (`architecture.md:106`) cites no constant; `AGENTS.md:21` names
  `packages/claude-plugin` and `packages/codex-plugin`, which do not exist; `policies eval` on an
  `off` policy abstains (undocumented); bench defaults include an unsendable 4,096 size
  (`cli.ts:83,466`); `mcp.ts:55` marks `decide` read-only though it writes the log, and `:42-44`
  promises calibration the openai path lacks.
- **Direction:** one pass fixing each, plus `readOnlyHint: false`, required input keys in the
  MCP `policies` output, and bench default 3800.
- **Open questions:** none.
- **Status:** done (2026-11-21) — README retention 365 days, `AGENTS.md` layout, 2 s routing
  timeout constant, `policies eval` on `off`; `mcp.ts` now sets `readOnlyHint: false` on `decide`,
  words confidence per engine, and lists input keys in `policies`.

### D2 Skills and onboarding

- **Priority:** P2. **Size:** S.
- **Problem:** Two skills exist (`plugins/local-decider/skills/*/SKILL.md`); both assume
  `local-decider` on PATH. Missing: explain a decision by id (the id is in the reason text,
  `packages/hooks/src/output.ts:469`), mark a decline as not-a-safety-issue, doctor/status,
  onboarding. The settings skill omits that `decisionTimeoutMs` must stay below the hook budget.
- **Direction:** `explain`, `doctor` and `mark-decline` skills with a `command -v` first step;
  a note on timeouts; a short onboarding flow (shadow, stats, act).
- **Open questions:** should `explain` be a CLI command first (F6) and the skill a thin wrapper?

### D3 Test gaps

- **Priority:** P1. **Size:** M.
- **Problem:** No `SerialQueue` or `SupervisedEngine` tests; no redaction key-context, Basic
  prose or URL edge tests; no stdin over 4 MiB or oversized timeout test
  (`packages/hooks/test/main.test.ts`); guard bypass cases missing; no real Claude/Codex payload
  fixtures; Paseo `tryAllow` error discrimination, lingering `pending`, routing budget sharing,
  explicit model override and `failed` turn untested; no client component tests; no abuse tests
  for `/v1/usage` and `/v1/outcomes`.
- **Direction:** land each test with the item that fixes its subject (S1, S7, R1, R2, R6, R7,
  S6); add recorded harness payload fixtures under `packages/hooks/test/fixtures/`.
- **Open questions:** react-native-testing-library for the Paseo client, or extract logic?

## Future capabilities

### F1 Deterministic pre-filter layer

- **Priority:** P1. **Size:** M.
- **Problem:** Every decision today costs an inference (1.2–2.5 s on CPU), and hard denies live
  only in the hook guard. Comparable tools (nah, destructive_command_guard) resolve obvious cases
  with a taxonomy and no model.
- **Direction:** a gateway-side rule layer before the engine: a command taxonomy (read-only,
  reversible in project, destructive, network, exfil) plus the guard's deny list; obvious cases
  return without inference and are logged with `source: rules`; hard deny never depends on the
  model. Rules only ever produce `deny`, `ask` or `skip-to-model`; a rule `allow` needs the same
  threshold floor as policies and an explicit opt-in per policy.
- **Open questions:** share the taxonomy with the hook guard (one bundle) or keep the hook guard
  minimal and the gateway rich?

### F2 Generic hook adapter for other harnesses

- **Priority:** P2. **Size:** L.
- **Problem:** Cursor, Gemini CLI, Copilot, Cline and Windsurf all use Claude-style JSON stdin
  PreToolUse hooks with small payload and verdict differences; Amp's `delegate` permission helper
  and OpenCode plugins are near fits. local-decider supports three harnesses.
- **Direction:** a harness-shape table in `packages/hooks` (input mapper, allowed verdicts,
  fail-open output) and a `--harness` flag or auto-detect; where "ask" cannot be expressed
  (Windsurf, Cline, Copilot cloud) fall through with no opinion, never deny by default. Ship
  Cursor and Gemini CLI first.
- **Open questions:** which harnesses have stable, documented payloads today?

### F3 Stuck-loop detection policy

- **Priority:** P2. **Size:** M.
- **Problem:** `turn-outcome` classifies a finished turn, but a session that repeats the same
  failing command or edit for ten turns is only visible after the fact.
- **Direction:** a `session-health` policy fed by a rolling per-session digest (hashes of recent
  commands, repeated error signatures, edit churn) kept in the gateway's in-memory call store;
  answers `progressing`, `looping`, `thrashing`; action `notify` only. Nothing is executed and no
  state text is stored.
- **Open questions:** can the hooks provide a session id consistently across harnesses?

### F4 Cost and token budget policy

- **Priority:** P2. **Size:** M.
- **Problem:** Routing picks a preset at creation; nothing watches spend during a task.
  `/v1/usage` already receives token counts from Paseo.
- **Direction:** a `budget` policy: per-project or per-agent token and dollar budgets in
  `config.yaml`, deterministic thresholds (no model needed), actions `notify` and a
  `route:<cheaper>` hint on the next turn. Never stops an agent.
- **Open questions:** does Paseo allow mid-session model switches from a plugin?

### F5 Learning from verified labels

- **Priority:** P3. **Size:** L.
- **Problem:** Precedent is exact-match only. Templates, embeddings and a label store are planned
  but gated on volumes (about 89 permission labels a day, zero for command-risk) and on the
  forgery fix (S6).
- **Direction:** template precedent (normalised command shape) gated on experiment E2; an opt-in
  embedding store once 2,000 verified labels exist; calibration-hint promotion with Wilson bounds.
  All learned paths lower a threshold toward a floor; none can produce `allow` on their own, and
  one verified `unsafe` label vetoes. Planned in: `docs/research/scaling-plan.md`,
  `docs/research/scaling-storage-embeddings.md`.
- **Open questions:** who verifies labels on Claude Code and Codex before Q2 lands?

### F6 Explainability and review surface

- **Priority:** P1. **Size:** M.
- **Problem:** A decision id appears in the hook reason text, but there is no way to look it up;
  Paseo rows are one line; there is no view of "what would act mode have done this week".
- **Direction:** `local-decider explain <id>` (record, probabilities, rule matched, precedent,
  redaction counts); `local-decider review --days N` listing disagreements; optionally a
  loopback-only static page served by the gateway behind the control token (S4). Hash-only data,
  no state text.
- **Open questions:** keep the redacted subject line for N days to make review useful, or stay
  hash-only?

### F7 Eval suite as a release gate with model cards

- **Priority:** P2. **Size:** M.
- **Problem:** Calibration differs per model, thresholds do not transfer, and no result is
  recorded in the repo.
- **Direction:** extend Q5: a `docs/models/<id>.md` card per supported model with fixture pass
  rates, reliability buckets and recommended thresholds, regenerated by a manual workflow;
  releases list the models the cards were produced with.
- **Open questions:** hardware for the nightly job (NPU models cannot run on GitHub runners).

### F8 Profile routing and delegate

- **Priority:** P2. **Size:** L.
- **Problem:** Routing chooses a model preset; Paseo also has profiles (system prompt, tools,
  mode). Picking a profile for a task is the same fixed-choice shape.
- **Direction:** per the research note: a `profile-routing` policy in shadow, `/delegate <task>`
  and a Command Center screen, dynamic options from the profile list, `optionSetHash` in records.
  Profiles that carry a more permissive mode are never selectable (allow-list only). Planned in:
  `docs/research/paseo-profile-routing.md`.
- **Open questions:** does a 9-option, 2k-token request fit the 2 s create budget?

### F9 Budget-aware scheduling and a power setting

- **Priority:** P2. **Size:** M.
- **Problem:** About a quarter of command-risk checks exceeded the 1.5 s hook budget; the gateway
  cannot tell a hook (must answer now) from a shadow job (can wait). Laptops on battery pay for
  shadow inference.
- **Direction:** adapters send `budgetMs`; the queue refuses early or runs shadow later; an
  `onBattery`/`onPowerSave` setting with `normal|shadow|bypass|off`. Power state can only reduce
  enforcement, never produce `allow`. Planned in: `docs/research/scaling-plan.md` (phases 2.1,
  4).
- **Open questions:** power detection on Linux (upower) and macOS (pmset) without new deps.

### F10 Session context for better answers

- **Priority:** P3. **Size:** M.
- **Problem:** `Stop` reads 16 KiB head and tail of the transcript, so `task` can be a compaction
  summary; permission decisions see one call without the task that motivated it.
- **Direction:** cache the first user prompt per session at `UserPromptSubmit` in the gateway's
  in-memory call store (redacted, TTL), and attach it as `task` to later decisions in the same
  session. No persistence.
- **Open questions:** does the extra context raise accuracy enough to pay for the tokens on CPU?

### F11 Policy authoring assistant

- **Priority:** P3. **Size:** M.
- **Problem:** Criterion wording moves probabilities a lot (0.25 vs 0.81 on one example), and
  authors tune by hand.
- **Direction:** `local-decider policies lint` (schema, thresholds, duplicate keys) and
  `policies suggest` that clusters shadow disagreements by subject shape and proposes fixture
  lines, never auto-edits a policy.
- **Open questions:** clustering without storing subject text means working from the redacted
  subject line kept briefly (see F6).

### F12 Headless and CI mode

- **Priority:** P3. **Size:** M.
- **Problem:** Copilot's cloud agent turns "ask" into "deny" and headless Claude sessions abort
  after repeated blocks; a decider that resolves routine asks with an audit trail removes stalls.
- **Direction:** a `--headless` profile: a fail-closed option for hooks that support it (Cursor
  `failClosed`, Copilot), a JSONL audit export per run, and a stricter allow floor. Default stays
  fail-open and loopback.
- **Open questions:** who reviews the audit trail, and where does the gateway run in CI?

## Review 2026-11-20: strands-decider v0.4.0

Baseline `b9df2bb`. A second review pass after
[strands-decider v0.4.0](https://github.com/strands-labs/strands-decider/releases/tag/v0.4.0):
an upstream diff, a Linux acceleration check, a fresh code review and a survey of other
`/v1/systemone` models. IDs: **N** findings, **X** harness ideas, **U** upstream adoption, **M**
other models. Verify cited lines before implementing; they come from a read-only review.

### Status of earlier items

- **Done:** S1, S2 (floor 0.8), S3, S4, S5, I1, the 3,800-token bench default, `calibrate`.
- **Mostly done:** R1 (coalescing and `budgetMs` open), Q1, Q2 (Codex and `PermissionDenied`
  open), R6 client half.
- **Wrong above:** I2 says bundles are committed, but `plugins/local-decider/dist` is built in CI;
  Q3 says the mod covers only Bash/Edit/Write, but it also covers MultiEdit and NotebookEdit. D1
  was done on 2026-11-21: the README retention and the `AGENTS.md` package list now match the code.

### Shipped with this review

- strands-decider pinned to the PyPI release `0.4.0` instead of a git commit, `uv.lock`
  regenerated, and `engine install` runs `uv sync --locked` so a stale lock fails instead of
  silently installing the old engine.
- A `rocm` install flavour (`whl/rocm7.2`, torch 2.14.1) with host detection (`/dev/kfd` plus a
  `gfx` agent in `rocminfo`). On a Radeon 880M (gfx1150), Strands 2B answered a short decision in
  about 190 ms warm, against about 2.4 s on the CPU.
- `maxConcurrency` in the strands engine config passes `serve --max-concurrency`.
- The `cuda` flavour pulls upstream's `cuda` extra (flash-linear-attention).
- Attribution for Strands Decider in `NOTICE`, the README and `docs/engines.md`.

### N1 PermissionRequest hook auto-allows any tool, including plan approval

- **Status:** done — `permission-tools.ts` allowlists the tools a PermissionRequest may be allowed
  for (everything else abstains before the gateway call and again in `translate`), one shared
  `isEnforcedAllow` in core serves hook and mod, and the mod validates the gateway reply.
- **Priority:** P0. **Size:** S.
- **Problem:** `hooks.json` matches `*` for `PermissionRequest`, and `decideAndTranslate`
  (`packages/hooks/src/run.ts`) never reads `tool_name`, so an enforced allow can approve
  `ExitPlanMode`, answer `AskUserQuestion` or allow an unknown MCP tool. The mod's allow check
  (`mod/register.ts`, `enforced && action === 'allow'`) is weaker than `translate` (`output.ts`)
  and casts the gateway reply without validation (`mod/gateway.ts`).
- **Direction:** a tool allowlist for `PermissionRequest` (Bash, Edit, Write, MultiEdit,
  NotebookEdit, read-only MCP) that abstains otherwise; one shared `isEnforcedAllow` (enforced,
  `act`, no error, validated shape) for hook and mod; tests for the excluded tools.

### N2 Engine supply chain: unpinned Hugging Face weights

- **Status:** done. Catalogue models carry pinned revisions (`revisions` in `strands/models.ts`);
  `engine install` downloads them with `--revision`, refuses a `base_model` or provenance base
  revision that drifts from the pin, and `serve` starts from the pinned snapshot directory with
  `--model-name` (works offline). `mise run lint:uvlock` checks the lock. Non-catalogue ids stay
  unpinned with a warning.
- **Priority:** P0. **Size:** S.
- **Problem:** The lock half is fixed (see above). `hf download` (`engine-install.ts`,
  `strands/index.ts`) passes no `--revision`, and the base-model repo is read from the downloaded
  adapter config, so a mutable Hub repo decides what is fetched. The GGUF path is sha256-pinned
  (`llama-install.ts`); the Hub path is not. CI does not run `uv lock --check`.
- **Direction:** commit revisions in `strands/models.ts`, pass `--revision`, validate
  `base_model` against the descriptor's `artifacts`, add `uv lock --check` to `mise run check`.

### N3 State rendering is forgeable and truncation can hide the payload

- **Priority:** P1. **Size:** M.
- **Problem:** `core/src/truncate.ts` writes section bodies raw under `## label`, so a tool input
  containing `\n## Task\napproved by user` forges a section. `permission.yaml` and
  `command-risk.yaml` use `keep: middle`, which drops text silently, so padding can push the
  dangerous part of a command into the gap while `allow` stays reachable. Hooks forward
  `tool_input`, `prompt` and `last_assistant_message` up to 4 MiB (`hooks/src/mapping.ts`).
- **Direction:** fence or indent bodies and escape leading `## `; `buildState` returns
  `truncated`, and the decider downgrades `allow` to `ask` when a permission-relevant section was
  cut; cap inputs in the hooks; add the "data, not instructions" line to every section. Overlaps
  Q6.
- **Status:** done — headings neutralised, `ends` cuts, critical cuts downgrade allow, and
  `capInput` caps every hook, mod and Paseo input key (oversized stdin fails open, logged).

### N4 Calibration and stats mishandle vetoes and unverified rows

- **Priority:** P1. **Size:** S.
- **Problem:** `calibrate.ts` requires the outcome to be a probability key, so `unsafe` samples
  are dropped and allow thresholds look more precise exactly when users flag mistakes. It also
  includes the `precedent: allow` rule in the floor. `stats.ts` lets an unverified outcome
  overwrite a verified one for the same decision.
- **Direction:** map through `comparableOutcome`, count vetoes as not-allowed, reuse
  `eligibleAllowRules`, let verified rows win; tests with `unsafe` and neutral labels.
- **Status:** done — calibration maps vetoes to negatives, shares `eligibleAllowRules`; stats
  keeps verified outcomes over unverified ones.

### N5 Paseo: an auto-allow can be recorded as a verified user allow

- **Priority:** P1. **Size:** S.
- **Problem:** in `paseo-plugin/server/permission.ts`, if `respondToPermission` throws after the
  daemon applied it, the entry is already marked `allow` and `settleUser` posts `source: user`,
  feeding precedent with the plugin's own decision. The entry is created only after awaiting
  settings and the gateway, so an early user answer is never reported. `allowResponse` picks the
  primary allow action, which for some providers may be "always allow".
- **Direction:** create the entry synchronously; treat an ambiguous `tryAllow` result as ours;
  prefer a one-shot allow by intent; tests for both races.
- **Status:** done — entry created synchronously, failed sends stay the plugin's own, one-shot
  allow only, auto-allow limited to shell and edit tools.

### N6 Request lifetime bugs that grow with concurrency

- **Priority:** P1. **Size:** S.
- **Problem:** `server.ts` creates the request abort signal after `await readJson(req)`, so a
  client that leaves during the body read never aborts. `engines/lazy.ts` re-arms the idle timer
  when a decision starts and tracks no in-flight work, so idle unload can stop the engine
  mid-request. Identical hashes run in parallel (`decider.ts`). `maxConcurrency` makes these
  visible.
- **Direction:** signal before the body read; an in-flight counter that defers unload, switch and
  benchmark holds; coalesce by hash. Land with X3.
- **Status:** done — signal before body read, in-flight drain, hash coalescing with waiters.

### N7 Engine child hygiene: environment, argv, error handler

- **Priority:** P1. **Size:** S.
- **Status:** done — env allowlist, reserved `extraArgs` flags, spawn error handler, exit reaper.
- **Problem:** `engines/supervised.ts` passes the whole `process.env` (bearer, report and
  `tokenEnv` secrets) to the engine; there is no `child.on('error')`, so spawn `ENOENT` is
  unhandled; children are not killed on gateway exit. `extraArgs` (`strands/index.ts`) can carry
  `--host 0.0.0.0` or `--port`, defeating the loopback bind.
- **Direction:** an environment allowlist (`PATH`, `HOME`, XDG, `HF_*`, ROCm/CUDA variables);
  reject bind, port and device flags in `extraArgs`; error handlers; an exit hook.

### N8 MCP `decide` is an oracle and pollutes stats

- **Priority:** P2. **Size:** S.
- **Status:** done — policy `mcp: false` gates `permission`/`command-risk`; `policies` trimmed;
  MCP/CLI rows skipped by stats, calibration, precedent.
- **Problem:** `mcp.ts` runs any policy, including `permission` and `command-risk`, and the
  `policies` tool returns thresholds, so an agent can probe which phrasing yields an allow before
  the real tool call. MCP and CLI decisions enter agreement, savings and calibration.
- **Direction:** cap `mcp` at `shadow` or a policy allowlist, trim `policies` output, exclude
  `mcp` and `cli` rows from calibration.

### X1 Screenshot approvals for browser and computer-use agents

- **Harness:** Paseo `browser_*` tools, Claude Code computer-use MCP. **Priority:** P3.
  **Size:** L.
- **What:** a `ui-action` policy ("may I click Pay/Submit/Delete here") from a screenshot plus the
  pending action, using the v0.4.0 image input (`images` in the request; v2 checkpoints read
  images natively).
- **Risk:** images bypass redaction and truncation: a typed `images` field, size and count caps,
  opt-in per policy, never forwarded to openai-compatible engines, and `ask`/`notify`/`deny` only
  until fixtures exist.

### X2 Token readout for explanations and calibration

- **Harness:** all; `explain` (F6) and the Paseo row expand (H1). **Priority:** P2. **Size:** M.
- **What:** store per-option token mass from the v2 token readout next to probabilities;
  `calibrate` fits temperature on it; `explain <id>` shows the margin. Store option tokens only,
  never state tokens.

### X3 Fleet concurrency

- **Harness:** Paseo multi-agent, Claude Code subagent bursts. **Priority:** P2. **Size:** M.
- **What:** scale queue slots with `maxConcurrency`, add `budgetMs` admission so hooks fail open
  early instead of timing out, and treat the new 503 (queue timeout) as busy. Needs N6 first.
- **Status:** done — queue slots follow `maxConcurrency`; `budgetMs` admission fails open as busy;
  stats count `busy`.

### X4 Lighter install through the torch-free core

- **Harness:** install path for all. **Priority:** P3. **Size:** M.
- **What:** v0.4.0 adds a `Backend` protocol and a numpy `HiddenStateEngine`, and its Lambda
  recipe runs the decider torso as a Q8_0 GGUF in llama.cpp. A llama.cpp Vulkan backend would run
  Strands models without the 3 GB torch download. The wheel still depends on torch today, so this
  needs upstream packaging or our own shim; `strandsRuntimeVersion` must not depend on torch
  metadata.

### X5 Subagent supervision via `PostToolUse` on `Agent|Task`

- **Harness:** Claude Code. **Priority:** P2. **Size:** M.
- **What:** run `turn-outcome` on the subagent's result and tell the parent `stuck` or
  `needs_input` through `additionalContext`; feeds F3. Notify only; never block or continue a
  turn.
- **Status:** done (2026-11-21) — `SubagentStop` cannot reach the parent (`systemMessage` is
  user-only; `block` and `additionalContext` keep the subagent running), so a synchronous
  `PostToolUse` hook on `Agent|Task` runs the argv-only `SubagentResult` event
  (`hooks/src/subagent.ts`). Shadow by default; `act` mode adds fixed text with no agent
  quotes. Claude only: Codex has no equivalent event.

### X6 Verified deny labels from `PermissionDenied`

- **Harness:** Claude Code. **Priority:** P1. **Size:** S.
- **What:** pair `PermissionDenied` with the `PermissionRequest` decision by `tool_use_id` and post
  `deny` with the report token, replacing the subject-keyed pairing in `hooks/src/pending.ts`. The
  first verified labels outside Paseo (unblocks F5).
- **Status:** not feasible as written (2026-11-21). Per the hooks reference, `PermissionRequest`
  carries no `tool_use_id`, and `PermissionDenied` fires only for auto-mode classifier denials,
  never for a manual deny. Subject-keyed pairing in `pending.ts` stays. A classifier denial could
  feed a separate, unverified "external judge" agreement metric; not planned.

### X7 Codex parity: path guard and `apply_patch`

- **Status:** done (2026-11-21) — `write-guard.ts` denies `.git`/`.ssh` writes (workflows ask on
  Claude, deny on Codex) and `PermissionRequest` abstains on outside-cwd or protected targets;
  input over 4 MiB runs the guard only, and over 32 MiB asks on Claude and denies on Codex (S7).
- **Harness:** Codex. **Priority:** P2. **Size:** M.
- **What:** port the mod's `deterministicBlock` and `insideCwd` checks to the Codex `PreToolUse`
  path and guard `apply_patch` targets (`.git`, `.github/workflows`, `.ssh`).

### X8 Scheduled review and idle shadow replay in Paseo

- **Harness:** Paseo schedules and heartbeats. **Priority:** P3. **Size:** S.
- **What:** a daily schedule runs `local-decider review --days 1` and posts disagreements and
  calibration drift; a heartbeat replays queued shadow decisions only when idle (F9). Read-only.

### X9 Per-agent tool channel instead of MCP injection

- **Harness:** Paseo. **Priority:** P2. **Size:** M.
- **What:** expose `decide` and `explain` through the plugin session's tools with a preapproved
  tool policy, so no gateway URL or token lands in agent MCP config (answers S5's open question).
  Serve shadow-only answers to agents (N8).

### U1 Strands v2 checkpoints

- **Status:** partly done. E2B v2 is in `strands/models.ts` (`generation: 2`, adapter and base
  pinned to the upstream-recorded revisions, not recommended); `mlx.ts` never resolves MLX for it,
  `device: mlx` fails the start, and the selector and `appleFresh` skip MLX for v2. A `/v1/systemone`
  503 now counts as busy (X3). Open: the E4B, 12B, 26B-A4B and 31B v2 repos are not public yet;
  benchmark E2B v2 on ROCm and macOS before changing `recommended`; MLX behaviour untested on macOS.
- **Priority:** P2. **Size:** S.
- **Problem:** v0.4.0 adds Gemma 4 v2 checkpoints (`strands-decider-<size>-gemma4-v2-2611`,
  32k context, native images, token readout). Only E2B v2 was on Hugging Face on 2026-11-20
  (Decision Index 57.1, against 29.8 for E2B v1). v2 runs on the new transformers backend only:
  `--device mlx`, `--device-map` and `--vision` are v1-only, and `--dtype`, `--revision` and
  `--max-length` are v2-only.
- **Direction:** add E2B v2 to `strands/models.ts` with measured memory; make `mlx.ts` never pick
  MLX for a v2 model; benchmark it against the 2B v1 on ROCm before changing `recommended`.

### M1 Other `/v1/systemone` models

- **Priority:** P3. **Size:** S per model.
- **Problem:** several decision models now speak `/v1/systemone`, and llama.cpp's server has a
  native `/v1/systemone` endpoint (which release first ships it is unverified). Most can be
  catalogue entries on the existing `llama-vulkan` or `systemone-remote` engines, not new engines.
- **Candidates**, best fit for a Linux iGPU first (licences from model cards, nothing measured
  here yet):
  - [Kev](https://github.com/jaredpalmer/kev) 0.8B/4B/9B/27B (Qwen3.5, Apache-2.0): `kev.serve`
    speaks `/v1/systemone` with torch on CUDA/ROCm; GGUF quants by
    [TurinTech Artemis](https://huggingface.co/turintech) run in llama.cpp.
  - [pplx-decider-flash](https://huggingface.co/perplexity-ai/pplx-decider-flash-gguf-v1.2) 4B GGUF
    (Apache-2.0, text and images) through llama.cpp.
  - [Laya](https://github.com/NandhaKishorM/laya) v0.5: a 0.8B frozen reader with a small head,
    conformal sets and an abstain flag; whether its server speaks `/v1/systemone` is unverified,
    so it may need an adapter. The abstain flag maps well onto `ask`.
  - [Clef-Flash](https://huggingface.co/Cloudflare/clef-flash) 9B (heavy for shared memory),
    Bosun 0.6B/1.7B and jevos 1B (noul only) are worth a probe.
  - Skip for now: Drex (custom licence, 35B MoE), blink (non-commercial weights),
    CC-BY-NC scorers.
- **Direction:** benchmark Kev-0.8B/4B and pplx-flash GGUF on `llama-vulkan`, add the winners to
  its catalogue with sha256 pins, and check calibration with `local-decider calibrate`.

## Where it could be useful

- **Solo developers on Claude Code or Codex.** Decision: permission prompts and command risk.
  Integration: the existing plugin. Fit: good once an NPU or MLX engine keeps latency under the
  hook budget; on CPU it is shadow-only.
- **Paseo users running many agents.** Decision: "does this agent need me" and auto-allow of
  routine requests. Integration: the Paseo plugin. Fit: the strongest today, since Paseo reports
  outcomes and shows rows; risk is the un-awaited permission hook race.
- **Teams with model budgets.** Decision: routing a new task to a cheaper preset. Integration:
  presets in `config.yaml`, usage reports. Fit: good in Paseo; hints only in Claude Code and
  Codex. Shadow savings are an upper bound.
- **Orchestrators supervising subagents.** Decision: answer a child's escalated request, with the
  parent's answer as precedent. Integration: `docs/supervised-subagents.md`. Fit: good; needs
  the deadline alignment in H2.
- **Air-gapped and regulated environments.** Decision: everything a hosted classifier would do.
  Integration: `systemone-remote` to a site-local engine. Fit: strong, nothing leaves the
  machine; redaction must be trusted (S1).
- **Headless CI coding agents.** Decision: resolve `ask` to allow or deny with an audit trail.
  Integration: F12 plus Copilot or Cursor hooks (F2). Fit: medium; fail-closed semantics are new
  territory for this project.
- **Security and platform teams.** Decision: a deterministic deny layer plus a shadow log of
  every tool call across a fleet. Integration: F1, the SQLite export. Fit: good as evidence and
  tuning data; the log is hash-only by design.
- **Other harness vendors or power users** (Cursor, Gemini CLI, Cline, OpenCode, Amp).
  Decision: pre-tool permission and stop-hook outcome. Integration: F2. Fit: depends on each
  harness's ability to express `ask`.
- **Browser and computer-use agents.** Decision: "may I click Submit, pay or delete" and "is
  the task finished". Integration: a new adapter and policy; screenshots stay local. Fit:
  promising, untested; the state is images or accessibility trees, not text.
- **SRE and runbook agents.** Decision: classify a proposed `kubectl` or `terraform` step as
  read-only, reversible or destructive, with a human page-out below the threshold. Integration:
  MCP `decide` tool plus a `command-risk` variant. Fit: medium; criteria need domain examples.
- **Support and ticket-triage agents.** Decision: route to tier, escalate or answer, refund
  within policy. Integration: MCP `decide` with a custom policy. Fit: small models are adequate,
  PII stays local; outside the coding focus, so documentation only.
- **Researchers of small decision models.** Decision: none; the bench, fixtures and calibration
  stats are the product. Integration: `local-decider bench`, F7 model cards. Fit: good, cheap to
  support.

## Suggested sequencing

1. **I1 Gate npm publish on CI.** Smallest change, closes the path where a failing commit ships.
2. **S2 and S3 together.** They close every way a policy file or a malformed engine answer can
   produce `allow` without a real, thresholded probability. Both are small and core-only.
3. **S1 Redaction.** The largest trust-boundary gap; structured tool inputs reach the engine
   unredacted today. Land with its tests.
4. **S4 and S5 Token scoping.** Control token on loopback, report token loopback-only, no bearer
   in agent MCP headers. Prerequisite for F6's review surface.
5. **R1 Queue admission.** Fixes the "queue full" starvation that makes hooks fail open under
   load, which is the main reason act mode feels unreliable.
6. **Q1 Typed outcome labels.** Stops declines from polluting precedent and calibration; every
   learning feature (Q2, F5) depends on clean labels.
7. **Q5 Fixtures and eval gate**, then **Q3/Q4** input and criteria tuning measured against them,
   so the known false positives are fixed with evidence rather than by feel.
8. **Q2 Hook outcomes.** Gives Claude Code and Codex their first feedback loop and makes
   command-risk learnable.
