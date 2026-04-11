# Feature 039: CLI Tool Detail Mode (M6-08)

Status: `done`  
Type: `P1 ux`

## Goal

为 tool 输出预留“折叠”语义，不做交互也能控制信息密度：

- `full`：显示完整 diff 内容
- `compact`：仅显示 diff 摘要（hunk 数/改动行数）

## Design

- 通过环境变量控制：`MERLION_CLI_TOOL_DETAIL=full|compact`
- 默认 `full`，保持现有可见性。
- `compact` 模式先用于 `edit_file` diff 卡片，后续可扩展到其他工具。

## Implementation

- `src/cli/diff.ts`
  - 新增 `summarizeEditDiff(payload)` 输出摘要行
- `src/cli/experience.ts`
  - 按 `toolDetailMode` 选择 `renderEditDiffLines` 或 `summarizeEditDiff`

## Tests

- `tests/cli_diff.test.ts`
  - 覆盖 `summarizeEditDiff` 输出结构与统计字段
