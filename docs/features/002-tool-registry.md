# Feature 002: `ToolRegistry`

Status: `in_progress`  
Type: `P0 core infrastructure`

## Goal

Implement an in-memory registry for built-in tools with deterministic behavior.

## Non-negotiable behavior

1. Register tool by unique name.
2. Duplicate name registration fails fast.
3. Lookup by name returns exact tool or `undefined`.
4. `getAll()` returns stable insertion order.

## Test plan

- `register and get by name`
- `duplicate registration throws`
- `getAll preserves insertion order`

