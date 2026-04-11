# Feature 013: Interactive REPL Mode (`--repl`)

Status: `in_progress`  
Type: `MVP interactive UX`

## Goal

Support interactive CLI without repeatedly invoking process:

- one process
- multi-turn prompt loop
- reusable session history
- optional `--resume <session-id>`

## UX contract

1. Start REPL:
   - `npm run merlion -- --repl --auto-allow`
2. Commands:
   - `:q` / `:quit` / `:exit` -> exit REPL
   - `:help` -> show help
3. Empty input is ignored.
4. Each valid prompt runs one agent turn and prints assistant output.

## Runtime design

1. Session init:
   - new session: create session files + append session meta + append system message once.
   - resume session: load existing transcript messages.
2. Keep in-memory `history: ChatMessage[]`.
3. For each user prompt:
   - call `runLoop` with `initialMessages=history`, `persistInitialMessages=false`
   - append new messages via `onMessageAppended`
   - replace `history` with returned `state.messages`
4. Continue until user exits.

## Test plan

- `parseReplInput` command parsing (`:q`, `:help`, empty, prompt)
- `runReplSession` control flow with injected IO and turn runner

