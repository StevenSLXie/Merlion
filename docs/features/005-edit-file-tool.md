# Feature 005: `edit_file` Tool

Status: `in_progress`  
Type: `P0 mutating tool`

## Goal

Implement safe `edit_file` with exact `str_replace` semantics.

## Non-negotiable behavior

1. Requires permission via `ctx.permissions.ask`.
2. Rejects paths outside workspace root.
3. Fails if file does not exist.
4. Fails if `old_string` appears zero times.
5. Fails if `old_string` appears multiple times.
6. Replaces exactly one occurrence and writes file.

## Test plan

- `replaces exact unique match`
- `fails when old_string not found`
- `fails when old_string has multiple matches`
- `denied permission blocks write`
- `outside-workspace path is rejected`

