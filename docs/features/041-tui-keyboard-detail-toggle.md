# Feature 041: TUI Keyboard Detail Toggle (M6-10)

Status: `done`  
Type: `P1 ux`

## Goal

在 fullscreen TUI 模式下不依赖 REPL 命令，直接通过键盘切换 tool 卡片细节等级。

## Keybindings

- `f` -> full detail
- `c` -> compact detail
- `?` -> show key help line
- `Ctrl+C` -> interrupt/exit (passthrough)

## Design

- 按键解析下沉到纯函数模块，避免 UI 层硬编码字符串判断。
- 仅在 `MERLION_CLI_TUI=1` 且 TTY 环境下启用 raw mode。
- 进程退出时自动恢复终端 raw mode。

## Implementation

- `src/cli/keybindings.ts`
  - `parseTuiKeyAction(input)` -> typed action
- `src/cli/experience.ts`
  - 启动 TUI 时绑定 stdin raw-mode key handlers
  - action 路由到 `setToolDetailMode` / help output / interrupt

## Tests

- `tests/cli_keybindings.test.ts`
  - 覆盖 key -> action 映射与 Ctrl+C 分支
