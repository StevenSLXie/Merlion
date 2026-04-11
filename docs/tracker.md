# Merlion Tracker

Last updated: 2026-04-11T15:50:00+08:00

## Active Sprint

- Sprint: `Phase1-Bootstrap-and-Tools`
- Focus: finish bootstrap and first tool with TDD
- Exit criteria:
  - `npm test` and `npm run typecheck` pass
  - first feature implemented with tests
  - feature spec written
  - one commit landed

## Task Board

| ID | Task | Status | Owner | Notes |
|---|---|---|---|---|
| M0-01 | Project baseline files | done | codex | package/tsconfig/gitignore created |
| M0-02 | Test baseline scripts | done | codex | `npm test` + `npm run typecheck` passing |
| M0-03 | Source skeleton | done | codex | `src/` + `tests/` initialized |
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
| M4-01 | tool-result budget truncation | todo | codex | next feature |

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
