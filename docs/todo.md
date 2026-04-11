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
- [x] `M6-03` Structured `edit_file` diff payload + red/green CLI rendering
- [x] `M6-04` Markdown-aware assistant renderer (headings/lists/code/table + fallback)
- [x] `M6-05` CLI message architecture unification (content type pipeline + layout cleanup)
- [x] `M6-06` Markdown code-fence language badge + unified status line formatter
- [x] `M6-07` Full-screen TUI shell (fixed header/footer + scrollable message area)
- [x] `M6-08` Tool detail mode (`full|compact`) for edit diff cards
- [x] `M6-09` Interactive detail toggle in REPL (`:detail full|compact`)
- [x] `M6-10` Keyboard-driven detail toggle in fullscreen TUI (`f`/`c`/`?`)
- [ ] `M6-11` Structured scrollback panes (assistant/tool split view)
- [x] `M6-12` First-run configuration wizard (API key + model, saved to `~/.config/merlion/config.json`)

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

## Milestone 10: Builtin Tool Expansion (P1/P2)

- [x] `M10-01` Free-code tool survey + priority ranking (critical subset)
- [x] `M10-02` Wave1 core file/navigation tools (`list_dir/glob/grep/write/append/delete/move/copy/mkdir/stat_path`)
- [x] `M10-03` Wave1 execution/meta tools (`list_scripts/run_script/git_status/git_diff/git_log`)
- [x] `M10-04` Wave1 productivity tools (`tool_search/todo_write/config_get/config_set/sleep`)
- [x] `M10-06` Wave1 strict parity hardening (`grep/search/glob` semantics + `tool_search/todo/config/sleep` alignment)
- [x] `M10-07` Bundle ripgrep for local + npm install (`@vscode/ripgrep` + unified runner)
- [x] `M10-08` File tool API compatibility alignment (`read/write/edit` aliases + `replace_all`)
- [ ] `M10-05` Wave2 advanced tools (web_search, notebook/lsp-like semantic helpers, task orchestration)

## Milestone 11: Packaging Parity (P1)

- [x] `M11-01` npm global install default color parity (`bin/merlion.js` entry bootstrap)
