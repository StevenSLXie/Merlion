# Feature 040: REPL Detail Toggle Command (M6-09)

Status: `done`  
Type: `P1 ux`

## Goal

在会话不中断的情况下动态切换工具详情密度，作为后续“交互式折叠”前置能力。

## User Command

- `:detail full`
- `:detail compact`

## Design

- 命令在 REPL 层解析为结构化事件（不进入模型上下文）。
- `index.ts` 将该事件路由到 `CliExperience.setToolDetailMode(mode)`。
- 切换后立即生效，后续 tool 卡片按新模式渲染。

## Implementation

- `src/cli/repl.ts`
  - 解析 `:detail full|compact`
  - 新增 `onSetDetailMode` 回调
  - help/startup 文案同步更新
- `src/index.ts`
  - 将 detail-mode 事件绑定到 UI 实例
- `src/cli/experience.ts`
  - 暴露 `setToolDetailMode(mode)`，支持运行时更新

## Tests

- `tests/repl.test.ts`
  - 覆盖命令解析（大小写）
  - 覆盖 REPL 执行链（回调触发 + 输出确认）
