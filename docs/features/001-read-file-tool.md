# Feature 001: `read_file` Tool

Status: `in_progress`  
Type: `P0 core tool`

## Goal

Implement a deterministic `read_file` tool that:

- reads file content by path (absolute/relative)
- supports optional `start_line` and `end_line` (1-indexed, inclusive)
- protects runtime from oversized files (>1 GiB)
- returns line-numbered output for code readability

## Non-negotiable behavior

1. Path resolves relative to `ctx.cwd` when not absolute.
2. Directory path is rejected (`isError: true`).
3. Missing file is rejected (`isError: true`).
4. File larger than 1 GiB is rejected (`isError: true`).
5. Empty file returns `(empty file)`.
6. Line range beyond file end is not an error; return existing lines only.

## Test plan

- `reads full file with line numbers`
- `reads requested line range`
- `returns error for missing file`
- `returns error for directory path`
- `returns empty marker for empty file`
- `returns error for >1 GiB file`

