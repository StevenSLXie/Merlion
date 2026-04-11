# Feature 025: Tool Result Budget Truncation (M4-01)

Status: `done`  
Type: `P0 context budget`

## Goal

统一限制工具输出进入上下文的体积，避免大日志/大文本结果推高 token 成本。

## Scope

1. 在 runtime executor 层做统一截断（工具无感）
2. 优先保留首尾信息（head + tail）
3. 附加明确截断标记
4. 支持环境变量调参

## Config

- `MERLION_TOOL_RESULT_MAX_CHARS` (default `6000`)
- `MERLION_TOOL_RESULT_MAX_LINES` (default `220`)

## API

- `applyToolResultBudget(content, options?)`
  - 返回：`content`, `truncated`

## Test Plan

- 文本未超限不变
- 超行数触发截断并带标记
- 超字符触发截断并保留首尾
- executor 集成后，超大工具输出被自动截断

## Exit Criteria

- 单测通过
- executor 全局生效
