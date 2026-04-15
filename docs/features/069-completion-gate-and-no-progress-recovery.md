Status: done

# 069 Completion Gate And No-Progress Recovery

## Goal

Reduce wasted turns after bad tool usage by:

1. preventing premature completion when the agent has used tools but made no successful file change
2. nudging the agent when it keeps exploring without producing any file mutation

## Scope

This change is runtime-level and general-purpose. It does not assume benchmark-only behavior.

## Design

### Completion gate

If the loop has already executed tool batches, saw tool errors, and has not recorded any successful file mutation, a `stop` response that looks like completion should not be accepted immediately.

The loop should inject one bounded recovery message asking the model to:

- inspect target files/tests
- make one minimal edit if the task requires edits
- or explain concretely why no edit is needed

### No-mutation recovery

If several consecutive tool batches finish without any successful file mutation, the loop should inject a bounded hint that broad exploration is not producing material progress.

This is intentionally weaker than a hard stop. Read-only tasks must still be allowed to finish naturally.

## Validation

- Added runtime unit tests for:
  - no-mutation hint injection
  - mutationless completion recovery
- Re-ran selected real bench cases after implementation to compare correctness and latency distribution.
