# Merlion

[简体中文](README.zh-CN.md)

**A lightweight CLI coding agent built as a reference implementation.**

Merlion is a working coding agent you can run from the terminal or from WeChat. It is built as a reference implementation: small enough to read, but complete enough to show the real shape of a coding agent. Context assembly, tool execution, session persistence, and verification are all here in code you can actually follow.

Compared with broader tools such as Claude Code and Codex CLI, Merlion keeps the product layer intentionally thin so the runtime stays legible. The point is twofold: the core path is compact without being partial, and if coding agents are going to matter, we need a lightweight system that helps us understand what one actually is.

## What This Repo Contains

- A runtime loop with planning, tool execution, retries, guardrails, and verification
- A context system with orientation, compact summaries, path guidance, and layered `AGENTS.md` / `MERLION.md`
- A builtin tool layer for files, search, shell, git, config, and LSP-assisted edits
- Two transports: terminal REPL first, plus optional WeChat inbox mode
- Bench and regression lanes for fixture tests, BugsInPy, and SWE-bench Lite

## Why It Stays Lightweight

- The core path stays short, but the essential pieces are still there: loop, tools, context, sessions, guardrails, verification
- The codebase is small enough to read end-to-end without reverse-engineering a large product surface
- It runs as a local Node.js runtime rather than depending on a hosted control plane
- The tool layer is practical, but still narrow enough to understand without days of setup
- The architecture is opinionated on purpose: fewer abstractions, fewer hidden systems, less ceremony

Lightweight here does not mean incomplete. It means the runtime is kept narrow enough that the design decisions are still visible.

## Quick Start

Merlion requires Node.js `>=22`.

Global install:

```bash
npm install -g merlion
merlion
```

Project-local install:

```bash
npm install merlion
npx merlion
```

On first run, Merlion opens a setup wizard for provider, API key, and model. It works with OpenAI-compatible endpoints, including custom base URLs.

Common usage:

```bash
# one-shot
merlion "read src/index.ts and summarize the startup flow"

# interactive REPL
merlion

# continue a previous session
merlion --resume <session-id>
```

## Architecture Entry Points

If you want to read the code rather than just run it, start here:

- `src/index.ts`: CLI bootstrap, config resolution, session wiring
- `src/runtime/loop.ts`: main agent loop
- `src/runtime/executor.ts`: tool execution and model turn handling
- `src/runtime/query_engine.ts`: conversation runtime
- `src/context/*`: orientation, compacting, path guidance
- `src/tools/*`: tool registry and builtin tools
- `src/transport/wechat/*`: WeChat transport

There is also a higher-level technical overview in [`docs/merlion_runtime_technical_overview.md`](docs/merlion_runtime_technical_overview.md).

## WeChat Mode

Merlion can use WeChat as an agent inbox.

```bash
# first time or token refresh
merlion wechat --login

# daily use
merlion wechat
```

Inside REPL, you can also trigger login directly:

```text
:wechat
/wechat
```

Credentials are stored at `~/.config/merlion/wechat.json`.

By default, WeChat receives final replies and concise error hints, not internal tool logs. If you want progress updates, set `MERLION_WECHAT_PROGRESS=1`. For more detailed progress, set `MERLION_WECHAT_PROGRESS_VERBOSE=1`.

Interactive terminal approvals are not available in WeChat mode. The default falls back to `--auto-allow`. Use `--auto-deny` if you want risky tools to be blocked.

## What Merlion Is Not

- Not a product-comparison project; it is a runtime to read, run, and extend
- Not trying to reproduce every workflow and integration from broader agent tools
- Not a stable SDK or platform layer yet
- Not optimized for non-technical onboarding first
- Not interested in hiding architectural tradeoffs behind a black box

Merlion is a small, opinionated runtime meant to stay understandable while still covering the essential shape of a real coding agent.
