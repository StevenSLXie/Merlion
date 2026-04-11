# Feature 008: Minimal Runnable Agent (Provider + Loop + CLI)

Status: `in_progress`  
Type: `MVP runnable path`

## Goal

Make Merlion runnable from terminal with one-shot task execution:

1. Parse CLI args.
2. Build provider from env.
3. Run ReAct loop with built-in tools.
4. Return final assistant output.

## Non-negotiable behavior

1. Loop handles `tool_calls` and continues until terminal response.
2. Tool call arguments are parsed as JSON.
3. Unknown tool call returns tool error message (no crash).
4. `--model` and `--base-url` override defaults.
5. Running `npm run merlion -- "task"` executes one-shot mode.

## Test plan

- `loop executes tool call then completes`
- `loop handles unknown tool safely`
- `loop returns terminal assistant text`

