# Feature 037: CLI Code-Fence Badge And Status Line (M6-06)

Status: `done`  
Type: `P1 ux`

## Goal

继续对齐 free-code 风格的“信息密度 + 可读层次”：

- markdown 代码块显示语言标签（如 `code:ts`）
- usage 输出改为统一状态行（含 turn 增量、累计、缓存比例、成本）

## Design

- markdown parser 在 code fence 起始行发出 `code_meta` 语义行。
- assistant 内容渲染管线识别 `code_meta`，以强调样式显示。
- 状态行格式提取为纯函数，CLI 只负责着色输出。

## Implementation

- `src/cli/markdown.ts`
  - 新增 `code_meta` 类型
  - 解析 ```lang 为 `code:<lang>` 行
- `src/cli/message_content.ts`
  - 增加 `code_meta` tone
- `src/cli/status.ts`
  - `formatCliStatusLine(snapshot, estimatedCost?)`
- `src/cli/experience.ts`
  - 使用统一状态行 formatter
  - `code_meta` 强调展示

## Tests

- `tests/cli_markdown.test.ts`
  - 覆盖 code-fence 语言标签输出
- `tests/cli_status.test.ts`
  - 覆盖状态行格式（delta/totals/缓存比例/cost）
