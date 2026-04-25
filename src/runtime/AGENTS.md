# Runtime AGENTS Guidance

<!-- BEGIN MANUAL -->
## Purpose
- Owns model turn loop, tool execution sequencing, and session-side state transitions.

## Key Files / Entry Points
- `loop.ts`: core state machine.
- `executor.ts`: tool batch execution and concurrency.
- `session.ts`: transcript + usage persistence and resume loading.
- `prompt_observability.ts`: stable prefix and role token breakdown.

## Local Constraints
- Keep terminal semantics stable: `completed | max_turns_exceeded | model_error`.
- New recovery branches must be bounded to prevent loops.
- Keep transcript/usage hooks consistent with tests.
- Request-local overlay items in `query_engine.ts` / `loop.ts` must stay visible for the active `submitPrompt()` run but must not be appended into persistent transcript history or resume state.
- Prompt observability in `loop.ts` / `prompt_observability.ts` must be recorded from the fully assembled per-turn request layers plus the actual registry passed to the provider; do not reuse runner-startup tool-schema estimates.
- Recovery paths that call back into the provider from `loop.ts` (for example synthetic or natural-summary fallback turns) must thread the active prompt-observability tracker through the helper callsite, not just the main turn loop.
- Turn-level task control is derived in `query_engine.ts` before `runLoop()`: update task-state and the profile-filtered registry there, but keep provider-visible request assembly in `runLoop()` via the canonical request builder fed by prompt-prelude content, execution charter text, and turn-local overlays.
- Overlay canonicalization and overlay non-persistent classification share one owner in `items.ts`; when adding new path-guidance, guardrail, recovery, or intent-contract templates, update the shared overlay descriptor tables there instead of introducing new ordering or pruning logic elsewhere.
- When re-creating a `QueryEngine` in-process, resume from `QueryEngineSnapshot` rather than only `items` so sticky capability-profile epochs survive provider or runtime rebuilds.
- Subagent role semantics are runtime-bound: workers must stay in implementation mode, explorers/verifiers stay read-only even if prompt wording is vague.
<!-- END MANUAL -->

<!-- BEGIN AUTO -->
## Subareas
- (managed by directory AGENTS files)

## EntryPoints
- (keep in MANUAL if needed)

## RecentChanges
- src/runtime/AGENTS.md
- src/runtime/loop.ts
- src/runtime/prompt_observability.ts
- src/runtime/session.ts
- src/runtime/executor.ts
- src/runtime/budget.ts
- src/runtime/cost_gate.ts
- src/runtime/usage.ts

## HighChurnFiles
- src/runtime/loop.ts (changes=15)
- src/runtime/session.ts (changes=5)
- src/runtime/executor.ts (changes=4)
- src/runtime/prompt_observability.ts (changes=2)
- src/runtime/AGENTS.md (changes=1)
- src/runtime/budget.ts (changes=1)

## RecentCommits
- 2026-04-12 4d9ff8f feat(context): path-guided AGENTS maps and commit-time maintenance
- 2026-04-12 2d4c240 fix(observability): persist prompt cache tracker across turns and include tool schema tokens
- 2026-04-12 9e4dc64 feat(observability): add prompt-level cache/token diagnostics in cli
- 2026-04-12 362e07a feat(tools): implement wave1 top-priority builtins from free-code survey
- 2026-04-11 d52ea25 feat(usage): surface provider route and cache-hit diagnostics

## LastUpdated
- 2026-04-12
- directory: src/runtime
<!-- END AUTO -->
