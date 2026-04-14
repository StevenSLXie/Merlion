# Merlion

Merlion is a coding agent you can drive from terminal or WeChat.
It stays engineering-oriented (tools, session memory, verifiable edits), while keeping setup simple.

## Install from npm (Recommended)

```bash
npm install -g merlion
merlion
```

Project-local install:

```bash
npm install merlion
npx merlion
```

On first run, Merlion opens a setup wizard for provider/key/model.

## Why Merlion

- OpenAI-compatible runtime (`openrouter` / `openai` / custom base URL)
- Tool-first coding loop (read/search/edit/bash/git + verification flow)
- Session continuity (`--resume`) with project orientation context
- WeChat transport mode: scan once, then continue coding conversations from your phone

## WeChat Vibe Coding Mode

Use your WeChat as the agent inbox.

```bash
# first time or token refresh
merlion wechat --login

# daily use
merlion wechat
```

Inside REPL, you can also trigger QR login directly:

```text
:wechat
/wechat
```

`:`/`/wechat` in REPL now performs login and immediately enters listening mode (Ctrl+C returns to REPL).

Credentials are stored at `~/.config/merlion/wechat.json`.
WeChat chat receives final turn replies (plus concise error hints), not internal tool logs.
By default WeChat sends only final replies (plus concise error hints).
If you want turn-by-turn progress, set `MERLION_WECHAT_PROGRESS=1`.
Set `MERLION_WECHAT_PROGRESS_VERBOSE=1` to include extra per-turn tool-batch summaries.
Progress updates are capped per request (`MERLION_WECHAT_MAX_PROGRESS_UPDATES`, default `10`) and auto-silenced on server throttling.
If a complex task hits turn budget, increase `MERLION_WECHAT_MAX_TURNS` (default `50`).
Interactive terminal approvals are not available in WeChat mode; default falls back to `--auto-allow`.
Use `--auto-deny` if you want risky tools to be blocked.

## Common Usage

```bash
# one-shot
merlion "read src/index.ts and summarize architecture"

# interactive REPL
merlion

# continue previous session
merlion --resume <session-id>
```

## AGENTS/MERLION Map Automation

Merlion supports layered `MERLION.md`/`AGENTS.md` guidance and auto-maintained `AUTO` sections.

```bash
npm run hooks:install
npm run agents:update:staged
npm run agents:lint
```

---

# Merlion（中文）

Merlion 是一个可以在终端和微信两端协同使用的 coding agent。
它强调工程可落地：工具调用、会话记忆、可验证改动。

## npm 安装（推荐）

```bash
npm install -g merlion
merlion
```

项目内本地安装：

```bash
npm install merlion
npx merlion
```

首次运行会自动进入配置向导（provider / key / model）。

## Merlion 的独特点

- 兼容 OpenAI 协议（`openrouter` / `openai` / 自定义 base URL）
- 面向工程任务的工具链（读搜改跑 + verify）
- 会话可恢复（`--resume`），并带项目上下文导向
- 微信接入：扫码登录后，可直接在手机上持续“vibe coding”

## 微信模式（亮点）

```bash
# 首次登录或 token 过期后
merlion wechat --login

# 日常直接连接
merlion wechat
```

在 REPL 里也可以直接弹二维码登录：

```text
:wechat
/wechat
```

REPL 里的 `:wechat` / `/wechat` 现在会“登录后直接进入监听模式”（按 `Ctrl+C` 返回 REPL）。

凭据保存位置：`~/.config/merlion/wechat.json`。
微信端默认只接收每轮最终答复（外加简短错误提示），不会推送内部工具日志。
如需开启逐轮进度推送，可设置 `MERLION_WECHAT_PROGRESS=1`。
如需更细粒度（含每轮工具批次汇总），可设置 `MERLION_WECHAT_PROGRESS_VERBOSE=1`。
每次请求的进度推送有上限（`MERLION_WECHAT_MAX_PROGRESS_UPDATES`，默认 `10`），遇到服务端限流会自动静默后续进度。
复杂任务若触达轮次上限，可调大 `MERLION_WECHAT_MAX_TURNS`（默认 `50`）。
微信模式不支持终端交互式审批；默认会回退到 `--auto-allow`，如需严格阻止高风险工具请使用 `--auto-deny`。

## 常用命令

```bash
merlion "read src/index.ts and summarize architecture"
merlion
merlion --resume <session-id>
```

## AGENTS / MERLION 地图自动维护

```bash
npm run hooks:install
npm run agents:update:staged
npm run agents:lint
```
