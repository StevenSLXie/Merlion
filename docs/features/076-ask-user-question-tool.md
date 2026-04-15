# 076 AskUserQuestion Tool

## Goal
- Add a structured `ask_user_question` builtin tool that lets the model pause execution, ask the user one or more concrete questions, and resume with the answers as tool output.
- Match free-code's interaction model closely enough that later skill / plan flows can depend on it.

## Why
- Merlion currently only has implicit clarification via assistant prose. That is weak for ambiguous requirements, branching implementation choices, and plan confirmation.
- A dedicated tool improves execution quality by making clarification explicit, structured, and testable.

## Scope
- Add builtin tool `ask_user_question`
- Add CLI runtime support for interactive question handling
- Expose structured question payloads through `ToolContext`
- Filter tool from non-interactive pools through existing `requiresUserInteraction` policy

## Non-Goals
- No plan mode dependency
- No GUI/TUI widget beyond line-based CLI prompts
- No WeChat support in this phase
- No persistence of Q&A outside the current transcript

## Tool Contract
- Name: `ask_user_question`
- Read/write class: interactive, non-destructive
- Parameters:
  - `questions`: array of 1-3 question objects
- Each question object:
  - `header`: short label
  - `id`: stable snake_case identifier
  - `question`: user-facing prompt
  - `options`: 2-4 suggested options
  - `multiSelect`: optional boolean
- Each option:
  - `label`: short user-facing choice
  - `description`: one-line tradeoff

## Output Contract
- Successful tool output returns JSON text with:
  - `answers`: record keyed by question `id`
- Selection behavior:
  - single-select questions accept option number or free text
  - multi-select questions accept comma-separated option numbers or free text
- Free text remains allowed even when options are present

## Runtime Design
- Extend `ToolContext` with an optional `askQuestions` handler
- CLI runtime implements the handler with line-based prompts
- If the handler is missing, the tool returns a clear error
- WeChat mode continues to exclude the tool through `requiresUserInteraction`

## Prompt / UX
- The model can ask focused clarifying questions instead of guessing
- CLI rendering per question:
  - header + prompt
  - numbered options
  - input hint
- Returned answers are plain JSON so the model can parse them reliably

## Files
- `src/tools/builtin/ask_user_question.ts`
- `src/tools/types.ts`
- `src/runtime/runner.ts`
- `src/tools/catalog.ts`

## Tests
- unit:
  - valid single-select choice
  - valid multi-select choice
  - free-text answer passthrough
  - missing interactive handler returns error
- regression:
  - `wechat` tool pool excludes the tool
  - runtime loop can call the tool and continue

## E2E
- one interactive clarification flow in REPL-disabled runtime
- one mixed tool flow where the model asks a question before editing or summarizing
