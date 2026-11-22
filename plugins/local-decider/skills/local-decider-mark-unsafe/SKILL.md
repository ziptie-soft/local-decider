---
name: local-decider-mark-unsafe
description: Record that a request local-decider allowed was unsafe, so precedent and calibration learn from it. Use when the user says an auto-allowed tool call should not have been allowed and gives or points to a decision id.
---

# local-decider mark-unsafe

Start by checking the CLI exists: `command -v local-decider || echo missing`. If it is missing,
tell the user to install it (see the Quick start in the local-decider README) and stop.

An `unsafe` label is a verified veto: it overrides a matching allow in precedent and counts
against the model in `local-decider stats` and `review`. It cannot be undone from the CLI, so
confirm with the user first.

1. Get the decision id (from the reason text, or find it with `local-decider review`).
2. Show the decision, so the user sees what they are labelling:

   ```sh
   local-decider explain <decision-id>
   ```

   Do not paste request text into the conversation; the output is hash-only.
3. Ask the user to confirm that this decision should be labelled unsafe. Do not label on an
   assumption, and never label a decision the user has not named.
4. Only after an explicit yes:

   ```sh
   local-decider label <decision-id> unsafe --yes
   ```

   It talks to the local gateway only and needs it running. Never print or look at the report
   token it reads. Pass on any warning it prints: a decision without a precedent key teaches no
   precedent, and an allow older than 25 hours is too old to be replayed as a veto.
5. Report what the command said. If the gateway refuses or is down, run
   `local-decider gateway status` (or the `local-decider-doctor` skill) and do not retry blindly.

A decline needs no label: when the user declined a request, that is already neutral and
nothing should be recorded. `label` accepts only `unsafe`.
