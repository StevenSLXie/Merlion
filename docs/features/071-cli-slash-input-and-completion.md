# Feature 071: REPL Slash Input And Completion

Status: `in_progress`
Type: `P1 CLI/UX`

## Goal

在 REPL 模式支持 slash 命令输入体验：

- 用户输入 `/` 时，不按 Enter 就能看到候选命令
- 首版只支持系统级 slash command：
  - `/wechat`
- slash 不进入 agent loop 的普通 tool/skill 体系
- slash 只在 REPL 生效

## UX

- 输入 `/`
  - 显示当前可用 slash command 候选
- 输入 `/we`
  - 候选收敛到 `/wechat`
- 按 Enter
  - 触发对应系统级动作

首版候选源：

- 系统级 slash commands

后续可以接：

- skills

## Design

### New Modules

- `src/cli/commands.ts`
  - slash command registry
- `src/cli/completion.ts`
  - completion 计算逻辑
- `src/cli/input_buffer.ts`
  - REPL 输入缓冲、inline completion 预览、TTY fallback

### Scope

- In:
  - slash completion 只针对 REPL
  - `/wechat` 生效
  - 非 TTY 环境自动 fallback 到普通 `readline`
- Out:
  - 不在这次接入 skill completion
  - 不做多层弹窗/TUI
  - 不把普通 tools 混进 slash completion

## Acceptance Criteria

1. `/` 开头输入在 REPL 中可显示候选预览。
2. `/wechat` 能正常触发现有 WeChat 登录/监听动作。
3. 非 TTY 模式不回归，继续使用普通逐行输入。

## Verification

- `node --experimental-strip-types --test tests/cli_completion.test.ts`
- `node --experimental-strip-types --test tests/repl.test.ts`
