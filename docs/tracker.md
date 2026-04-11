# Merlion Tracker

Last updated: 2026-04-12T05:00:00+08:00

## Active Sprint

- Sprint: `Phase1-Hardening`
- Focus: phase1 closeout + maintain test green
- Exit criteria:
  - 剩余 P0 TODO 清零
  - `npm run test:all` 和 `npm run typecheck` 通过

## Task Board

| ID | Task | Status | Owner | Notes |
|---|---|---|---|---|
| M0-01 | Project baseline files | done | codex | package/tsconfig/gitignore created |
| M0-02 | Test baseline scripts | done | codex | `npm test` + `npm run typecheck` passing |
| M0-03 | Source skeleton | done | codex | `src/` + `tests/` initialized |
| M1-01 | Core shared types hardening | done | codex | feature 030; transcript parse validation added |
| M2-01 | read_file tool with TDD | done | codex | 6 tests pass |
| M1-02 | Tool registry + tests | done | codex | 3 tests pass |
| M2-03 | create_file tool + boundary guard | done | codex | 5 tests pass |
| M2-02 | search tool with TDD | done | codex | 4 tests pass |
| M2-04 | edit_file tool with boundary guard | done | codex | 5 tests pass |
| M2-05 | bash tool with risk guard | done | codex | 4 tests pass |
| M2-06 | fetch tool with TDD | done | codex | 5 tests pass |
| M3-01 | provider wrapper | done | codex | OpenAI-compatible non-stream |
| M3-04 | ReAct loop skeleton | done | codex | loop tests pass |
| M0-05 | minimal CLI one-shot | done | codex | `npm run merlion -- --help` works |
| M3-05 | transcript persistence + redaction | done | codex | session jsonl in data dir |
| M3-07 | usage ledger | done | codex | `.usage.jsonl` append per turn |
| M3-06 | resume reconstruction | done | codex | `--resume <session-id>` supported |
| M3-03 | tool executor batching | done | codex | partition + ordered results |
| M3-02 | retry strategy | done | codex | transient errors retried |
| M6-01 | interactive REPL mode | done | codex | `--repl`, `:help`, `:q` |
| M6-03 | edit diff payload + colored CLI diff | done | codex | feature 034; model sees summary only |
| M6-04 | markdown-aware assistant renderer | done | codex | feature 035; fallback to plain card |
| M6-05 | CLI render pipeline unification | done | codex | feature 036; unified assistant content pipeline |
| M6-06 | markdown code-fence badge + status formatter | done | codex | feature 037; richer code block cues + cached ratio line |
| M6-07 | full-screen TUI shell | done | codex | feature 038; optional `MERLION_CLI_TUI=1` with fixed header/footer |
| M6-08 | tool detail mode full/compact | done | codex | feature 039; edit diff supports compact summary mode |
| M6-09 | interactive detail toggle in REPL | done | codex | feature 040; `:detail full|compact` without restart |
| M6-10 | keyboard-driven detail toggle in TUI | done | codex | feature 041; keys `f/c/?` + Ctrl+C passthrough |
| M6-11 | structured scrollback panes (assistant/tool split) | todo | codex | pending renderer refactor |
| M7-01 | usage aggregator module + tests | done | codex | feature 014 |
| M7-02 | CLI real-time token usage line | done | codex | in `src/index.ts` |
| M7-03 | E2E usage archive output | done | codex | `.merlion/e2e-usage` |
| M8-01 | runtime/executor event hooks | done | codex | feature 017 |
| M8-02 | line-based renderer | done | codex | feature 017 |
| M8-03 | output sanitization | done | codex | feature 018 |
| M9-01 | cost baseline schema | done | codex | `docs/cost-baseline.json` |
| M9-02 | cost gate checker | done | codex | `src/runtime/cost_gate.ts` |
| M9-03 | cost gate warn/fail mode | done | codex | `MERLION_COST_GATE` |
| M4-01 | tool-result budget truncation | done | codex | `src/runtime/budget.ts` |
| M4-02 | compact summary | done | codex | `src/context/compact.ts` |
| M5-01 | check discovery | done | codex | `src/verification/checks.ts` |
| M5-02 | verification runner | done | codex | `src/verification/runner.ts` |
| M5-03 | fix-round integration | done | codex | `src/verification/fix_round.ts` + `src/index.ts` |
| M5-04 | multi-language discovery + requiresCommands skip | done | codex | feature 031; custom verify config supported |
| M5-05 | CI-first language-agnostic discovery | done | codex | feature 032; CI commands preferred over language fallback |
| M5-06 | verification edge-case hardening | done | codex | feature 033; explicit empty config and python command fallback fixed |
| M4-03 | AGENTS loader | done | codex | `src/artifacts/agents.ts` |
| M4-04 | progress artifact | done | codex | `src/artifacts/progress.ts` |
| M4-05 | codebase index loader | done | codex | `src/artifacts/codebase_index.ts` |
| M4-06 | orientation context assembly | done | codex | `src/context/orientation.ts` + `src/index.ts` |

## Commit Log

| Commit | Scope | Notes |
|---|---|---|
| (pending) | bootstrap + docs | moved docs, added blockers, todo/tracker |
| (pending) | feature 001 read_file | red->green tests + implementation |
| (pending) | feature 002 tool registry | red->green tests + implementation |
| (pending) | feature 003 create_file | red->green tests + implementation |
| (pending) | feature 004 search | red->green tests + implementation |
| (pending) | feature 005 edit_file | red->green tests + implementation |
| (pending) | feature 006 bash | red->green tests + implementation |
| (pending) | feature 007 fetch | red->green tests + implementation |
| (pending) | feature 008 minimal cli loop | red->green tests + implementation |
| (pending) | feature 009 session logging | red->green tests + implementation |
| (pending) | feature 010 session resume | red->green tests + implementation |
| (pending) | feature 011 tool executor batching | red->green tests + implementation |
| (pending) | feature 012 retry strategy | red->green tests + implementation |
| (pending) | feature 013 repl mode | red->green tests + implementation |
