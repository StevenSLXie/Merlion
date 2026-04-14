# Feature 070: Tool Definition Metadata Expansion

Status: `in_progress`  
Type: `P1 Runtime/Tools`

## Goal

在现有 `tool catalog + tool pool` 基础上，把 `ToolDefinition` 从“仅够执行”扩展成“也能表达来源和策略”的 contract。

这次不做复杂行为变更，重点是：

- 拉平 metadata 结构
- 在 catalog 中集中声明 builtin metadata
- 让 `tool_search` / `tool pool` / runtime 可见性层消费这批 metadata

## Why

当前 `ToolDefinition` 只有：

- `name`
- `description`
- `parameters`
- `concurrencySafe`
- `execute`

这足够执行，但不够表达：

- 工具来源
- 读写属性
- 是否 destructive
- 是否需要交互
- 搜索提示
- 为未来 defer / MCP merge 预留的信息

如果现在不补这层，后续做：

- deferred tools
- MCP tool adapter
- deny-rule prefilter
- richer tool search

都会反复返工 `ToolDefinition`、pool 和 listTools contract。

## Scope

- In:
  - 扩展 `ToolDefinition` metadata 字段
  - 扩展 `ToolContext.listTools()` 返回值结构
  - 在 `catalog.ts` 中为 builtin tool 集中赋 metadata
  - `tool_search` 纳入 `searchHint`
  - `tool pool` 支持按 `requiresUserInteraction` 做基础 mode 过滤
- Out:
  - 不在这次实现 deferred loading
  - 不在这次实现 MCP metadata 落地
  - 不在这次给每个 builtin tool 文件内逐个散落加 metadata

## Metadata Contract

新增字段全部为可选，保持兼容：

- `source?: 'builtin' | 'mcp' | 'extension'`
- `searchHint?: string`
- `isReadOnly?: boolean`
- `isDestructive?: boolean`
- `requiresUserInteraction?: boolean`
- `requiresTrustedWorkspace?: boolean`

说明：

- `source` 先由 catalog 统一赋值为 `builtin`
- `searchHint` 供 `tool_search` 提升召回质量
- `isReadOnly` / `isDestructive` 是未来 policy 和 UI 的基础
- `requiresUserInteraction` 先用于 mode 过滤
- `requiresTrustedWorkspace` 先只留 contract，不消费

## Design

### 1. 类型层

修改：

- `src/tools/types.ts`

新增：

- `ToolSource`
- `ToolSummary`

并把：

- `ToolContext.listTools?: () => ToolSummary[]`

### 2. catalog 作为 metadata 汇总点

修改：

- `src/tools/catalog.ts`

做法：

- 保持 builtin tool 的定义文件不散改
- 在 catalog 内建立一张 metadata map
- 输出时把 metadata merge 到 builtin tool definition

优点：

- 集中维护
- 减少文件触点
- 以后接 MCP/extension 时也能复用 catalog 产物

### 3. pool 首版消费点

修改：

- `src/tools/pool.ts`

新增规则：

- `wechat` mode 除了排除 `config/config_get/config_set`
- 还排除 `requiresUserInteraction === true` 的工具

这样未来如果新增需要互动的工具，不用再逐个在 mode 里硬编码名字。

### 4. tool_search 消费点

修改：

- `src/tools/builtin/tool_search.ts`

调整：

- 检索时纳入 `searchHint`
- 输出保留原有格式，不增加噪音字段

### 5. runtime 可见性层

`runLoop` 当前通过 `listTools()` 暴露给 `tool_search` 的只是 name + description。

本次改成暴露 `ToolSummary`，为：

- 更好的 tool search
- 后续 UI/permission/pool 决策

留接口。

## Files

- `src/tools/types.ts`
- `src/tools/catalog.ts`
- `src/tools/pool.ts`
- `src/tools/builtin/tool_search.ts`
- `src/runtime/loop.ts`
- `tests/tool_pool.test.ts`
- `tests/tools_meta_pack.test.ts`
- `tests/tool_registry.test.ts`

## Test Matrix

### Unit

- catalog assigns builtin source metadata
- catalog assigns metadata to representative tools
- tool_search query can match searchHint
- wechat mode excludes `requiresUserInteraction` tools
- listTools summary includes metadata fields

### Regression

- existing pool tests remain green
- existing tool registry tests remain green
- existing runtime loop tests remain green

### E2E Sample

至少抽 2-3 个：

- `e2e_read`
- `e2e_session_resume`
- `e2e_orientation_inject`

目的：

- 确认 metadata 扩展没有影响默认 tool execution

## Acceptance Criteria

1. `ToolDefinition` 支持 metadata，但现有工具实现保持兼容。
2. builtin metadata 由 `catalog.ts` 集中提供。
3. `tool_search` 能利用 `searchHint`。
4. `wechat` mode 可以基于 metadata 做至少一项过滤。
5. 抽样 E2E 通过。

## Verification

- `node --experimental-strip-types --test tests/tool_pool.test.ts`
- `node --experimental-strip-types --test tests/tools_meta_pack.test.ts`
- `node --experimental-strip-types --test tests/runtime_loop.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_read.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_session_resume.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_orientation_inject.test.ts`
