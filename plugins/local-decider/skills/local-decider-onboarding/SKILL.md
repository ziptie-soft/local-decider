---
name: local-decider-onboarding
description: Walk a new local-decider user through the safe rollout: run in shadow mode, read the stats, then switch a policy to act. Use when the user just installed local-decider, asks how to get started, or asks whether it is safe to turn a policy on.
---

# local-decider onboarding

Policies ship in `shadow` mode: they log what they would do and change nothing. Move through
the three stages and let the user decide at each one.

1. Check the CLI is installed:

   ```sh
   command -v local-decider || echo "missing"
   ```

   If missing, tell the user to install it (see the Quick start in the local-decider README)
   and stop. If something looks broken, use the `local-decider-doctor` skill.
2. **Shadow.** Run `local-decider gateway status` and `local-decider policies`; every policy
   should be in `shadow`. Confirm one decision works with `local-decider decide turn-outcome
   lastMessage="All tests pass; the PR is open."`. Then ask the user to work normally for a few
   days (at least 7 days and 300 decisions before `act` is a sound bet).
3. **Stats.** `local-decider stats --days 7` reports agreement with the user's own answers,
   calibration and estimated savings per policy; `local-decider calibrate` suggests thresholds
   once there are enough verified outcomes. Summarise the numbers and say plainly if they are
   too thin to judge.
4. **Act.** Only if the user agrees after seeing the numbers: `local-decider policies mode
   <policy> act`, one policy at a time (add `--scope claude-auto` for the Claude Code auto-mode
   scope). Hooks then change behaviour, so name the effect first. Revert with `policies mode
   <policy> shadow`.

Read `docs/security.md` in the local-decider repository before enabling `act`.
