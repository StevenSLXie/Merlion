# Feature 012: API Retry Strategy

Status: `in_progress`  
Type: `P0 runtime robustness`

## Goal

Implement bounded retry for transient model-provider failures.

## Non-negotiable behavior

1. Retry transient failures (`429`, `500`, `502`, `503`, `529`, network reset).
2. Do not retry permanent failures (`400`, `401`, `403`).
3. Use exponential backoff with jitter.
4. Stop retrying after max attempts.

## Test plan

- `retries transient errors then succeeds`
- `does not retry permanent errors`
- `fails after max attempts`

