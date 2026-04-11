# Feature 010: Session Resume

Status: `in_progress`  
Type: `MVP continuity`

## Goal

Allow continuing a previous session with `--resume <session-id>`.

## Non-negotiable behavior

1. Locate transcript by project hash + session id.
2. Rebuild messages from transcript `type=message` lines.
3. Continue loop from restored history.
4. Do not re-persist historical messages when resuming.

## Test plan

- `loads messages from existing transcript`
- `throws when session transcript not found`
- `runLoop accepts initial messages`

