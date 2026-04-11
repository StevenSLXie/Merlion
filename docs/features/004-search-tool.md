# Feature 004: `search` Tool

Status: `in_progress`  
Type: `P0 core read tool`

## Goal

Implement a `search` tool for code/text discovery using `rg` first and `grep` fallback.

## Non-negotiable behavior

1. Requires non-empty `pattern`.
2. Searches from `ctx.cwd` when path is omitted.
3. Uses `rg` if available; falls back to `grep -rn`.
4. Returns `(no matches found)` when no matches.
5. Truncates long output with explicit truncation note.

## Test plan

- `finds matches with line numbers`
- `returns no matches marker`
- `errors on invalid pattern input`
- `respects provided relative path`

