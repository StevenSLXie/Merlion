# Feature 044: CLI Color Parity For NPM Package

Status: `done`  
Type: `P1 ux`

## Problem

本地源码运行与 npm 安装版在颜色表现不一致，主要来自两点：

- REPL 默认启用 TUI（无 ANSI 红绿 diff）
- `FORCE_COLOR` 未被显式识别

## Solution

- 将 TUI 改为统一 **显式开关**：仅 `MERLION_CLI_TUI=1` 时启用
- 支持 `FORCE_COLOR` 强制启色（除 `NO_COLOR=1` 外）

## Implementation

- `src/cli/experience.ts`
  - 新增 `forceColorEnabled`
  - `tuiEnabled` 改为全模式显式 opt-in
  - `useColor` 增加 `FORCE_COLOR` 支持
- `bin/merlion.js`
  - npm 安装入口在 TTY 下默认设置 `FORCE_COLOR=1`
  - 仍可被 `NO_COLOR=1` 或显式 `FORCE_COLOR` 覆盖

## Verification

- `npm run build`
- `npm test`
