# Feature 034: CLI Edit Diff Rendering (M6-03)

Status: `done`  
Type: `P1 ux`

## Goal

在 `edit_file` 成功后，CLI 直接展示红绿代码改动，降低“改了什么”二次读取成本，同时不增加模型上下文 token。

## Design

- Tool 输出分为两层：
  - `content`: 给模型与 transcript（短摘要）
  - `uiPayload`: 仅给 CLI 渲染（不回灌模型上下文）
- `edit_file` 返回 `uiPayload.kind = edit_diff`，含：
  - `path`
  - `addedLines` / `removedLines`
  - `hunks`（行级 add/remove/context）
- Runtime 在 `onToolCallResult` 事件透传 `uiPayload`，CLI 消费并渲染。

## Implementation

- `src/tools/types.ts`
  - 新增 `ToolUiPayload` 与 `EditDiffUiPayload` 类型
- `src/tools/builtin/edit_file.ts`
  - 生成结构化 edit hunk
  - 模型文本改为短摘要：`Edited <path> (+x -y)`
- `src/runtime/executor.ts`
  - 在工具执行结果事件中透传 `uiPayload`
- `src/cli/diff.ts`
  - 统一 diff 行渲染与截断
- `src/cli/experience.ts`
  - 工具完成后显示 `EDIT DIFF` 卡片
  - `+` 绿色、`-` 红色、meta 黄色

## Token Policy

- 仅摘要进入模型消息；diff 明细只在终端显示，不进入 `messages[]`。
- 保留 `MERLION_CLI_DIFF_MAX_LINES` 截断阈值，避免终端刷屏。

## Tests

- `tests/edit_file.test.ts`：校验 `edit_file` 返回结构化 diff payload
- `tests/executor.test.ts`：校验 `onToolCallResult` 收到 `uiPayload`
- `tests/cli_diff.test.ts`：校验 diff 渲染格式与截断行为
