Status: `planned`
Type: `P1 Research/Validation`

# 093 Free-Code Audit And Test Plan

## Goal

把这轮改造拆成一个可执行的调研与测试计划，明确：

1. `free-code` 哪些细节值得继续深挖
2. 哪些不该照搬
3. Merlion 实现后应如何分层验证
4. 何时可以从 targeted replay 扩到 20-case 和更大批次

## Current Conclusion

对照 `free-code` 当前已经可以下结论：

1. Merlion 不是完全缺少元工具
2. 主要缺口是 `tool-specific guidance + workflow shaping + model-visible convergence`
3. 不能只改 prompt，也不能只加几个新工具

因此调研重点不该再停留在“它有哪些工具名”，而应落到：

- 工具 contract
- 工具 prompt
- tool result nudges
- workflow/meta-tool integration

## Free-Code Detail Checklist

下列点需要继续逐项核清楚，并记录是否采纳：

### A. Tool Contract Layer

来源：

- `src/Tool.ts`

要核清楚：

1. `prompt()` 和 `description()` 如何同时参与模型上下文
2. `strict` 对 schema 和 tool calling 的实际影响
3. `validateInput()` 是在模型前还是执行前触发
4. `renderToolUseMessage()` / `userFacingName()` 是否只是 UI 层
5. `checkPermissions()` / `toAutoClassifierInput()` 是否值得借鉴

结论预期：

- Merlion 首版应借鉴 `tool-specific prompt/guidance`
- 其余 hooks 只挑最需要的做，不必全搬

### B. ToolSearchTool

来源：

- `src/tools/ToolSearchTool/ToolSearchTool.ts`
- `src/tools/ToolSearchTool/prompt.ts`

要核清楚：

1. deferred tools 机制是否对 Merlion 真的必要
2. keyword scoring 哪些部分值得照搬
3. exact match / MCP prefix / required term 逻辑是否值得采纳
4. search result 为什么能比 Merlion 当前输出更有指导性

结论预期：

- deferred tool loading 不一定首批实现
- richer `select:` output 和 better ranking 值得借鉴

### C. TodoWriteTool

来源：

- `src/tools/TodoWriteTool/TodoWriteTool.ts`
- `src/tools/TodoWriteTool/prompt.ts`

要核清楚：

1. tool prompt 如何驱动使用频率
2. task close-out verification nudge 的触发条件
3. 一个 `in_progress` 约束是否足够刚性
4. todo 工具如何从“记录器”变成“流程控制器”

结论预期：

- verification nudge 值得借鉴
- overly long prompt 不需要照搬全文

### D. FileEditTool / FileReadTool

来源：

- `src/tools/FileEditTool/FileEditTool.ts`
- `src/tools/FileEditTool/prompt.ts`

要核清楚：

1. “先读后改”是 prompt 约束、runtime 约束还是两者都有
2. `old_string` 唯一性 guidance 如何写得足够短但有效
3. 输入校验层是否还包含 Merlion 当前没有的高价值 guardrail

结论预期：

- `edit_file` 工具 guidance 必须加强
- 不需要复制它的大量 file-history/LSP/permission 实现

### E. EnterPlanMode

来源：

- `src/tools/EnterPlanModeTool/prompt.ts`

要核清楚：

1. plan mode 在 `free-code` 里是默认路径还是保守路径
2. 哪类任务进入 plan mode
3. 哪些文案是对用户产品形态强绑定的，Merlion 不适合直接搬

结论预期：

- Merlion 首批不应直接实现 full plan mode
- 但“何时该先规划”值得抽象成更轻的 runtime/meta-tool规则

## Test Plan

### 1. Contract / Serialization Tests

目标：验证 tool-level guidance 能稳定到达模型侧。

测试：

- `ToolDefinition` guidance 字段兼容旧工具
- provider 序列化输出稳定
- `tool_search select:` 能返回 richer guidance

建议文件：

- `tests/executor.test.ts`
- `tests/tools_meta_pack.test.ts`
- provider serialization test

### 2. Tool-Specific Tests

目标：验证高风险工具有自己的 guardrail。

测试：

- `read_file` guidance / output contract
- `edit_file` read-before-edit / unique old_string guidance
- `bash` raw command / prefer dedicated tools hint
- `todo_write` verification nudge

建议文件：

- `tests/read_file.test.ts`
- `tests/edit_file.test.ts`
- `tests/bash.test.ts`
- `tests/tools_meta_pack.test.ts`

### 3. Runtime Convergence Tests

目标：验证模型在错误轨道上时，runtime 会把它拉回。

测试：

- malformed tool args immediate hint
- repeated exploration without mutation hint
- oversized diff self-review hint
- weak verification closeout hint
- non-canonical artifact hint

建议文件：

- `tests/runtime_loop.test.ts`

### 4. Verification Tests

目标：验证 verification 既能执行，也能被 agent/rule 层正确消费。

测试：

- verify discovery
- verify runner
- fix-round integration
- todo closeout to verification nudge

建议文件：

- `tests/verification_checks.test.ts`
- `tests/verification_runner.test.ts`
- `tests/verification_fix_round.test.ts`

### 5. Replay Set

目标：先在小而有代表性的集合上看行为变化，而不是直接跑 300。

第一批 replay：

- `psf__requests-2674`
- `mwaskom__seaborn-2848`
- `matplotlib__matplotlib-18869`
- `sympy__sympy-20590`

第二批 replay：

- 之前 20-case 中全部 unresolved/failed

第三批：

- 再跑 20 个新 case

### 6. Batch Gates

从 targeted replay 扩到 20-case 的门槛：

1. empty/malformed tool arg failures 明显下降
2. empty diff failures 接近 0
3. 非 canonical artifact cases 接近 0
4. replay set 至少有可观察改善

从 20-case 扩到更大规模的门槛：

1. summary/result 字段足够归因
2. harness 侧稳定
3. unresolved case 的主要 bucket 已经不是“工具层低级错误”

## Deliverables

本轮调研与实现完成后，至少应产出：

1. tool contract spec
2. builtin guidance spec
3. runtime convergence spec
4. 本测试计划
5. 一份 replay report，记录 before/after 变化

## Acceptance Criteria

1. `free-code` 借鉴点与非借鉴点都有明确结论。
2. 测试计划覆盖 unit / integration / replay / batch gate。
3. 后续实现可以按 spec 分阶段落地，而不是一次性大改。
