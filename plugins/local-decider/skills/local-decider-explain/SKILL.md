---
name: local-decider-explain
description: Explain why local-decider decided as it did for one tool call or decision id (the rule that fired, the margin to its threshold, precedent, outcome). Use when the user asks why a request was allowed, asked or denied, or hands you a decision id from a reason text.
---

# local-decider explain

`local-decider explain` reads the decision log read-only, so it works with the gateway down.
Its output is hash-only: it never contains the request text, so it is safe to quote.

1. Get the id. A reason text from local-decider carries a decision id; a harness tool call id
   works too and lists every decision of that call.
2. Run:

   ```sh
   local-decider explain <decision-id|call-id>
   ```

   Add `--json` when you need to process the result.
3. Summarise for the user: the policy and action, the model's primary answer and confidence,
   the rule that fired and how far the confidence was from its threshold, the precedent tally,
   and the outcome label if one exists. Rows logged before the explain fields existed print
   "not recorded (before F6)"; say so rather than guessing.
4. "unknown decision" means the id was pruned (`logs.retainDays`) or never recorded. If the
   store reports a schema mismatch, the gateway has not been restarted since the upgrade: ask the
   user to run `local-decider gateway restart`, then retry.

A decision the user declined needs no label: declines are neutral and never count as a veto.
To record that an allowed request was unsafe, use the `local-decider-mark-unsafe` skill. To list
the decisions your labels contradict, run `local-decider review`.
