Status: `planned`
Type: `P1 Runtime/Tools`

# 091 High-Signal Builtin Tool Guidance

## Goal

为少数高频且高风险 builtin tools 增加强 guidance，让模型在这些地方更少犯“低级但高成本”的错误。

首批工具：

- `read_file`
- `edit_file`
- `bash`
- `tool_search`
- `todo_write`

## Why

最近的 SWE-bench / medium-bench 样本暴露出的问题，不是“模型完全不会找代码”，而是：

1. `read_file` 路径参数被污染
2. `edit_file` 目标段选择过大或不唯一
3. `bash` 被滥用成 search/read 的替代品
4. `tool_search` 只是列名字，无法教模型怎么选工具
5. `todo_write` 只是存数据，没有真正驱动收敛

这些都属于 tool UX 问题，单靠全局 system prompt 不够。

## Non-Goals

- 不给所有 builtin tools 一次性补 guidance
- 不引入完整 plan mode
- 不把 benchmark-specific 规则直接写进工具 prompt
- 不让 tool prompt 变成长篇教程

## Design

### 1. read_file

`read_file` guidance 应明确：

1. path 必须是原始 workspace path
2. 优先小范围 targeted read，不要整文件反复扫
3. 如果路径不确定，先 `list_dir` / `glob` / `search`
4. line-number output 只是展示，不是文件内容本体

建议同时优化工具输出：

- 明确显示 resolved path
- 明确显示 returned line range

### 2. edit_file

`edit_file` guidance 应明确：

1. 先读后改
2. `old_string` 不要带 line-number prefix
3. 尽量用最小唯一上下文
4. 对 rename / repeated text 用 `replace_all`
5. 优先改已有文件，不要先新建替代文件

可以考虑加一个轻量 runtime contract：

- 若会话中从未读取目标文件，先给 soft failure 或强 warning

这里借鉴 `free-code` 的点主要是：

- “edit before read” 明确禁止
- old/new string 的匹配细节写进工具 prompt

### 3. bash

`bash` guidance 应明确：

1. shell 不是默认的 repo navigation 工具
2. 读文件优先 `read_file`
3. 搜索优先 `search/grep/glob`
4. 只有在运行 tests / scripts / environment checks 时优先 bash
5. command 只能是原始命令字符串，不能带 transcript 垃圾

同时建议增强工具错误信息分类：

- empty command
- command polluted by transcript
- command likely should use file/search tool instead

### 4. tool_search

`tool_search` 不应只是一个“列目录”的工具。

它应该显式承担两个职责：

1. 当模型不知道用哪个工具时，给 capability routing
2. 当模型拿不准参数时，返回 required params + usage hints

首版设计建议：

- 普通 query 返回：
  - tool name
  - short description
  - why it matches
- `select:<tool>` 返回：
  - name
  - description
  - required args
  - short guidance
  - common pitfalls

### 5. todo_write

当前 `todo_write` 在 Merlion 里更像状态存储，而不是行为工具。

首版应补：

1. 明确什么时候该建 todos
2. 明确多步任务必须有且仅有一个 `in_progress`
3. 完成全部任务前需要确认 verification 是否已覆盖
4. 当任务列表关闭但没有 verification 项时，tool result 应返回 nudge

这里最值得借鉴 `free-code` 的不是 prompt 的长度，而是：

- todo 关闭时会触发 verification nudge
- todo 工具是 workflow shaper，不是文档工具

## Files

- `src/tools/builtin/read_file.ts`
- `src/tools/builtin/edit_file.ts`
- `src/tools/builtin/bash.ts`
- `src/tools/builtin/tool_search.ts`
- `src/tools/builtin/todo_write.ts`
- `src/tools/catalog.ts`
- `tests/tools_meta_pack.test.ts`
- `tests/read_file.test.ts`
- `tests/edit_file.test.ts`
- `tests/bash.test.ts`

## Expected Impact

首批 guidance 不一定直接让 hard case solved，但应该明显降低：

- 伪路径参数
- edit target selection drift
- bash overuse
- 无计划长链 search/read
- 过早宣布完成

## Validation

### Tool-Level

- `read_file` guidance presence test
- `edit_file` guidance presence test
- `bash` guidance presence test
- `tool_search` select mode richer output test
- `todo_write` verification nudge test

### Behavioral

- 先读后改场景的 soft guardrail test
- `tool_search` 可以返回 required params 和 common pitfalls
- `todo_write` 在无 verification task 的 close-out 时返回 nudge

### Regression

- 现有文件工具测试全部继续通过
- 现有 metadata/search tests 继续通过

## Acceptance Criteria

1. 5 个高优先级工具都有独立 guidance。
2. `tool_search` 不再只返回“名字 + 描述”。
3. `todo_write` 能对流程收敛产生实际影响。
4. 新 guidance 不依赖 benchmark-specific 文案。
