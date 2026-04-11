# Feature 007: `fetch` Tool

Status: `in_progress`  
Type: `P0 core read tool`

## Goal

Implement HTTP(S) fetch with lightweight content normalization.

## Non-negotiable behavior

1. Only `http://` and `https://` URLs are allowed.
2. Returns status + content.
3. JSON responses are pretty printed.
4. HTML responses are stripped to text.
5. Supports response truncation by `max_length`.

## Test plan

- `fetches plain text`
- `pretty-prints json`
- `strips html tags`
- `rejects non-http scheme`
- `truncates long response`

