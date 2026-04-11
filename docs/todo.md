# Merlion TODO (Phase 1)

Status workflow: `todo` -> `in_progress` -> `blocked` -> `done`

## Milestone 0: Bootstrap (P0)

- [x] `M0-01` Initialize project baseline (`package.json`, `tsconfig.json`, `.gitignore`)
- [x] `M0-02` Test baseline (`npm test`, `npm run typecheck`)
- [x] `M0-03` Create source skeleton (`src/`, `tests/`)
- [x] `M0-04` Wire lightweight feature spec template (`docs/features/NNN-*.md`)

## Milestone 1: Core Types + Registry (P0)

- [x] `M1-01` Add `src/types.ts` and `src/tools/types.ts`
- [x] `M1-02` Add `src/tools/registry.ts` with unit tests

## Milestone 2: Built-in Tools (P0)

- [x] `M2-01` `read_file` tool with TDD
- [x] `M2-02` `search` tool with TDD
- [x] `M2-03` `create_file` tool (workspace boundary enforced) with TDD
- [x] `M2-04` `edit_file` tool (workspace boundary enforced) with TDD
- [x] `M2-05` `bash` tool (risk assessment + timeout) with TDD
- [x] `M2-06` `fetch` tool with TDD

## Milestone 3: Runtime + Session (P0)

- [x] `M3-01` Provider wrapper with non-stream completion (MVP)
- [x] `M3-02` Retry strategy
- [x] `M3-03` Tool executor + batching
- [x] `M3-04` ReAct loop skeleton
- [x] `M3-05` Transcript persistence (redaction included)
- [x] `M3-06` Resume reconstruction
- [x] `M3-07` Usage ledger (`.usage.jsonl`)

## Milestone 4: Context + Artifacts (P0/P1)

- [x] `M4-01` Tool-result budget truncation
- [x] `M4-02` Compact summary
- [x] `M4-03` AGENTS loader
- [x] `M4-04` Progress artifact
- [x] `M4-05` Codebase index loader
- [x] `M4-06` Orientation context assembly

## Milestone 5: Verification Loop (P1)

- [x] `M5-01` Check discovery
- [x] `M5-02` Verification runner
- [x] `M5-03` Fix-round integration
- [x] `M5-04` Multi-language check discovery + command dependency skip
- [x] `M5-05` CI-first language-agnostic discovery
- [x] `M5-06` Verification edge-case hardening (empty config semantics, command deps, output cap)

## Milestone 6: CLI UX (P1)

- [x] `M6-01` Interactive REPL mode (`--repl`) with `:help` and `:q`

## Milestone 7: Token/Cost Observability (P0)

- [x] `M7-01` Usage aggregator module with unit tests (turn delta + session total)
- [x] `M7-02` CLI real-time usage line per model response
- [x] `M7-03` E2E usage archive output (`.merlion/e2e-usage`)

## Milestone 8: CLI UX V1 (P1)

- [x] `M8-01` Runtime/executor event hooks for tool visualization
- [x] `M8-02` Line-based renderer for status/tool progress
- [x] `M8-03` Output sanitization for long opaque tokens/ansi noise

## Milestone 9: Cost Regression Gate (P1)

- [x] `M9-01` Baseline schema + initial fixture values
- [x] `M9-02` Cost gate checker in test flow
- [x] `M9-03` Configurable warn/fail modes
