# 077 LSP Tool

## Goal
- Add a builtin `lsp` tool for semantic code navigation in TypeScript / JavaScript workspaces.
- Prioritize coding leverage over protocol completeness.

## Why
- Merlion is still primarily text-search driven.
- Semantic symbol navigation reduces false matches and improves precise multi-file changes.

## Scope
- Add builtin `lsp` tool
- Implement a TypeScript-backed semantic service for:
  - definition
  - references
  - hover
  - document_symbols
  - workspace_symbols
  - diagnostics
- Auto-detect project config from workspace root

## Non-Goals
- No full generic LSP client/server manager in this phase
- No rename / code action / formatting yet
- No non-JS/TS languages yet
- No background daemon cache yet

## Tool Contract
- Name: `lsp`
- Read-only
- Parameters:
  - `action`: one of `definition`, `references`, `hover`, `document_symbols`, `workspace_symbols`, `diagnostics`
  - `path`: required for file-scoped actions
  - `line`: required for position-scoped actions
  - `character`: required for position-scoped actions
  - `query`: required for `workspace_symbols`

## Output Contract
- JSON text with stable top-level shape:
  - `action`
  - `path` or `query`
  - `results`
- Position coordinates are 1-based in both input and output
- Results include normalized relative paths where possible

## Implementation Design
- Add `src/tools/builtin/lsp.ts`
- Use the local `typescript` package to build a language service
- Resolve `tsconfig.json` / `jsconfig.json` from workspace root
- Fall back to inferred project with workspace JS/TS files when config is absent
- Cache service instances per cwd for the process lifetime

## Action Semantics
- `definition`
  - return one or more symbol definition locations
- `references`
  - return references excluding duplicate spans
- `hover`
  - return display text and documentation summary
- `document_symbols`
  - return file symbol tree flattened into stable rows
- `workspace_symbols`
  - return matching symbols across project files
- `diagnostics`
  - return syntactic + semantic diagnostics for the file

## Error Handling
- Unsupported file type returns a clear error
- Missing ts/js project files returns a clear error
- Invalid line/character returns a clear error
- Missing TypeScript runtime returns a clear error

## Files
- `src/tools/builtin/lsp.ts`
- `src/tools/catalog.ts`
- `src/tools/types.ts` only if additional metadata is needed

## Tests
- definition on imported symbol
- references across files
- hover returns type info
- document symbols returns named nodes
- workspace symbols returns query matches
- diagnostics returns compile error
- unsupported path returns error

## E2E
- semantic lookup task that should prefer `lsp` over repeated grep
- debug task where diagnostics help the model explain or fix a TS error
