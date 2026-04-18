Status: `planned`
Type: `P1 Runtime/Tools`

# 090 Tool Model Guidance Contract

## Goal

把 Merlion 的 `ToolDefinition` 从“仅够执行”的 contract，扩展成“同时能向模型表达高价值使用规则”的 contract。

目标不是把每个工具都塞成长 prompt，而是补一层稳定、可测试、可序列化的 tool-level guidance，让模型在调用工具前就能看到：

- 这个工具最适合做什么
- 哪些参数容易填错
- 哪些常见误用应该避免
- 何时优先用别的工具

## Background

当前 Merlion 的 tool contract 主要包含：

- `name`
- `description`
- `parameters`
- `concurrencySafe`
- `execute`

这足够让 provider 把 schema 发给模型，也足够本地执行；但不够表达每个工具自己的操作纪律。

这会带来几个结构性问题：

1. tool-specific guidance 只能堆进全局 system prompt
2. provider 无法把“正确使用方式”稳定绑定到具体工具
3. `tool_search` 最多只能返回“名称 + 简短描述”
4. runtime 只能在工具出错后补救，不能在调用前预防

对照 `free-code`，关键差异不在它多了多少底层文件工具，而在它的工具定义本身就支持 richer model contract：

- tool-specific `prompt()`
- tool-specific `description()`
- strict schema / validateInput
- render / userFacing / permission hooks

参考：

- `src/Tool.ts`
- `src/tools/FileEditTool/prompt.ts`
- `src/tools/TodoWriteTool/prompt.ts`
- `src/tools/ToolSearchTool/prompt.ts`

## Self-Review Findings

当前 Merlion 的主要缺口：

1. provider 发送给模型的 tool schema 只有 `description + parameters`
2. `description` 同时承担 UI 文案和模型指导，导致它既不够短，也不够强
3. `ToolDefinition` 没有 `modelGuidance` 之类的字段
4. `tool_search` 只能基于 `name/description/searchHint` 排序，无法回传 richer usage contract
5. runtime 只能靠 loop hint 补救，但很多误用本应在调用前避免

## Non-Goals

- 不引入和 `free-code` 一样完整的工具生命周期框架
- 不在这次重写所有 builtin tools
- 不在这次引入 deferred tools / lazy schema loading
- 不在这次改变 tool result wire format

## Design

### 1. Expand ToolDefinition For Model-Facing Guidance

在 `src/tools/types.ts` 里为 `ToolDefinition` 增加可选字段：

- `modelGuidance?: string`
- `modelExamples?: string[]`
- `guidancePriority?: 'normal' | 'critical'`

约束：

- 默认全部可选，保持兼容
- `description` 继续保留为简洁的人类可读摘要
- richer guidance 只走模型通道，不直接复用为 UI 文案

### 2. Add A Dedicated Serialization Layer

新增 provider-side helper，例如：

- `buildModelToolDescription(tool)`

职责：

1. 合并 `description`
2. 合并 `modelGuidance`
3. 视情况拼入少量 `modelExamples`
4. 做 deterministic trimming

结果应该是：

- 对 provider 来说仍然只发送标准 function description
- 对 Merlion 内部来说，tool guidance 的结构化来源是稳定的

### 3. Separate UI Summary From Model Guidance

不要让一个字段同时承担：

- CLI/UI 简述
- 模型侧完整行为约束

因此：

- `description` 继续保持短
- `modelGuidance` 承担规则与误用提醒
- 后续如果需要 CLI richer preview，再单独扩字段，不复用模型字段

### 4. Tool Search Must Be Able To Surface Guidance

`tool_search` 需要消费新的 model-facing metadata，而不仅仅是 `description/searchHint`。

首版可以先做到：

1. 搜索排序时继续用 `searchHint`
2. 返回结果时加入简短 guidance 摘要
3. `select:` 模式下返回完整可调用摘要，包括：
   - name
   - description
   - key required params
   - guidance summary

### 5. Guidance Budget

不是所有工具都值得长 guidance。

首版限制：

- 只给高频高风险工具补 guidance
- 每个工具 guidance 控制在短 bullet 范围
- examples 每个工具最多 1-2 条

优先级：

1. `edit_file`
2. `read_file`
3. `bash`
4. `tool_search`
5. `todo_write`

## Files

- `src/tools/types.ts`
- `src/providers/openai.ts`
- `src/tools/builtin/tool_search.ts`
- `src/tools/catalog.ts`
- `tests/tools_meta_pack.test.ts`
- `tests/provider_openai.test.ts` or new provider serialization test

## Expected Impact

这项改动本身不直接提高 solved rate，但会为后续两类改进打基础：

1. 工具误用前置预防
2. tool_search / meta-tools 输出增强

它应该优先改善：

- 参数污染
- 错用工具
- 过度依赖全局 system prompt 的问题

## Validation

### Unit

- `ToolDefinition` 新字段保持向后兼容
- provider 会把 `modelGuidance` 稳定并入 tool description
- description merge 顺序和截断规则稳定
- 无 guidance 的工具输出与当前行为兼容

### Tool Search

- `tool_search` 可以返回 guidance 摘要
- `select:` 模式能返回 required params + guidance

### Regression

- runtime loop tests 不受影响
- tool registry / tool pool tests 不受影响

## Acceptance Criteria

1. `ToolDefinition` 支持 model-facing guidance，但旧工具不需要立即修改。
2. provider 存在统一的 tool description serialization helper。
3. `description` 与 `modelGuidance` 职责分离。
4. `tool_search` 能消费新的 tool guidance 信息。
5. 高风险工具的 guidance 可以分批落地，而不必一次性覆盖全部工具。
