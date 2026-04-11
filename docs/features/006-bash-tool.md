# Feature 006: `bash` Tool

Status: `in_progress`  
Type: `P0 execution tool`

## Goal

Implement controlled shell execution with:

- risk assessment (`safe` / `warn` / `block`)
- permission gate
- timeout and output truncation

## Non-negotiable behavior

1. Block dangerous commands without prompting (`risk = block`).
2. Warn-level commands require permission.
3. Safe commands execute directly.
4. Timeout returns error and kills process.
5. Output includes exit code and supports truncation.

## Test plan

- `runs safe command`
- `blocks high-risk command`
- `warn-level command denied by permission`
- `times out long-running command`

