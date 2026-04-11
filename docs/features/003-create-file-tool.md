# Feature 003: `create_file` Tool

Status: `in_progress`  
Type: `P0 mutating tool`

## Goal

Implement a safe `create_file` tool with permission check and workspace-boundary guard.

## Non-negotiable behavior

1. Requires permission via `ctx.permissions.ask`.
2. Deny result returns `isError: true` and does not write.
3. Creates parent directories recursively.
4. Fails if target file already exists.
5. Rejects writes outside workspace root (`ctx.cwd`).
6. Returns deterministic success message with line/char counts.

## Test plan

- `creates new file and parent directories`
- `fails when file already exists`
- `denied permission blocks write`
- `outside-workspace path is rejected`

