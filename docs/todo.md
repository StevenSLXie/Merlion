# Merlion TODO (Phase 1)

Status workflow: `todo` -> `in_progress` -> `blocked` -> `done`

## Milestone 0: Bootstrap (P0)

- [x] `M0-01` Initialize project baseline (`package.json`, `tsconfig.json`, `.gitignore`)
- [x] `M0-02` Test baseline (`npm test`, `npm run typecheck`)
- [x] `M0-03` Create source skeleton (`src/`, `tests/`)
- [x] `M0-04` Wire lightweight feature spec template (`docs/features/NNN-*.md`)

## Milestone 1: Core Types + Registry (P0)

- [ ] `M1-01` Add `src/types.ts` and `src/tools/types.ts` (partial: `src/tools/types.ts` done)
- [x] `M1-02` Add `src/tools/registry.ts` with unit tests

## Milestone 2: Built-in Tools (P0)

- [x] `M2-01` `read_file` tool with TDD
- [x] `M2-02` `search` tool with TDD
- [x] `M2-03` `create_file` tool (workspace boundary enforced) with TDD
- [x] `M2-04` `edit_file` tool (workspace boundary enforced) with TDD
- [ ] `M2-05` `bash` tool (risk assessment + timeout) with TDD
- [ ] `M2-06` `fetch` tool with TDD

## Milestone 3: Runtime + Session (P0)

- [ ] `M3-01` Provider wrapper with stream handling
- [ ] `M3-02` Retry strategy
- [ ] `M3-03` Tool executor + batching
- [ ] `M3-04` ReAct loop skeleton
- [ ] `M3-05` Transcript persistence (redaction included)
- [ ] `M3-06` Resume reconstruction
- [ ] `M3-07` Usage ledger (`.usage.jsonl`)

## Milestone 4: Context + Artifacts (P0/P1)

- [ ] `M4-01` Tool-result budget truncation
- [ ] `M4-02` Compact summary
- [ ] `M4-03` AGENTS loader
- [ ] `M4-04` Progress artifact
- [ ] `M4-05` Codebase index loader
- [ ] `M4-06` Orientation context assembly

## Milestone 5: Verification Loop (P1)

- [ ] `M5-01` Check discovery
- [ ] `M5-02` Verification runner
- [ ] `M5-03` Fix-round integration
