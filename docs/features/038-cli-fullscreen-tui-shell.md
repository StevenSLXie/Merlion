# Feature 038: CLI Fullscreen TUI Shell (M6-07)

Status: `done`  
Type: `P1 ux`

## Goal

提供可选全屏终端壳层，接近 free-code 的固定布局体验：

- 固定 header（title/model/session）
- 可滚动消息区（显示最近日志）
- 固定 footer/status（turn/tool/usage 状态）

## Design

- 默认保持原输出模式，避免破坏稳定性。
- 通过环境变量显式开启：`MERLION_CLI_TUI=1`。
- 仅在 TTY 且非 REPL 模式生效。
- TUI 渲染层使用纯函数 frame 生成器，便于测试。

## Implementation

- `src/cli/tui_frame.ts`
  - `createTuiFrame(input)`：根据宽高构建完整 frame
  - 自动裁剪/补齐 body 区行数
- `src/cli/experience.ts`
  - 新增 TUI 模式分支与日志缓冲
  - `printRawLine` 在 TUI 模式下转为“追加日志 + 重绘”
  - `onUsage` 改为更新 footer status（而非刷普通日志行）

## Tests

- `tests/cli_tui_frame.test.ts`
  - 覆盖 frame 结构输出
  - 覆盖 body 仅保留最近行行为
