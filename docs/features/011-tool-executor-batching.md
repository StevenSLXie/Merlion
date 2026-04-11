# Feature 011: Tool Executor Batching

Status: `in_progress`  
Type: `P0 runtime efficiency`

## Goal

Introduce batched tool execution:

- group consecutive `concurrencySafe` tools into one parallel batch
- execute unsafe tools serially
- preserve final tool-result order to match tool call order

## Non-negotiable behavior

1. `partitionToolCalls` batching follows registry concurrency metadata.
2. Output tool messages preserve original tool-call order.
3. Unknown tools return tool error message in-place.

## Test plan

- `partition by concurrency safety`
- `execute preserves output ordering`

