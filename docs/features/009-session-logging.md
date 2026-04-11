# Feature 009: Session Transcript + Usage Ledger

Status: `in_progress`  
Type: `P0 observability and cost control`

## Goal

Persist run artifacts for replay and cost analysis:

1. Transcript JSONL (`session_id.jsonl`)
2. Usage JSONL (`session_id.usage.jsonl`)
3. Secret redaction before persistence

## Non-negotiable behavior

1. Create project-scoped data directory under `~/.merlion/projects/<hash>/`.
2. Write session metadata line first.
3. Persist each message append event.
4. Persist usage per assistant turn.
5. Redact common secrets before writing.

## Test plan

- `redacts bearer and key patterns`
- `appends transcript lines`
- `appends usage lines`

