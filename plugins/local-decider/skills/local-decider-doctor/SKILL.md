---
name: local-decider-doctor
description: Diagnose a local-decider install that does nothing, is slow or errors (gateway down, stale service, engine not loaded, policy or config errors, Codex hooks not trusted). Use when the user says local-decider is not working, hooks never fire, decisions are missing or the gateway seems unhealthy.
---

# local-decider doctor

Run the steps in order and stop at the first failure. Hooks fail open, so a broken setup looks
like "nothing happens", not an error.

1. Check the CLI is installed:

   ```sh
   command -v local-decider || echo "missing"
   ```

   If missing, tell the user to install it (`npm install -g @ziptie-soft/local-decider`, or see
   the Quick start in the local-decider README) and stop.
2. `local-decider gateway status` shows the user service state and the gateway health. It warns
   when the installed service unit has a stale `ExecStart` (it points at an old install path):
   run `local-decider gateway restart` after confirming with the user, then check status again.
   If the gateway is down, `local-decider gateway start`.
3. `local-decider engine list` shows the engines and models and which one is selected. If none
   is selected or the model is not installed, `local-decider engine install` (see its help for
   `--flavor`, `--model`) and `local-decider engine use <engine> <model>`.
4. Check that one decision works:

   ```sh
   local-decider decide turn-outcome lastMessage="All tests pass; the PR is open."
   ```

   An engine error or timeout here is the engine, not the hooks.
5. Check the files: `local-decider config check` validates `config.yaml`, and `local-decider
   policies` lists the policies with their modes (a policy in `off` is never asked). After
   editing a policy file run `local-decider policies check <file>`.
6. If decisions are slow, `local-decider bench` times the running model. The hooks give up
   after 1.5 s by default, so a CPU model suits shadow logging better than a per-call guard.
7. Codex only: Codex does not run untrusted plugin hooks, and an update changes them. Ask the
   user to open the Codex TUI and run `/hooks` to review and trust them again.

Report what you found and what you changed. Do not change a policy mode as part of the
diagnosis.
