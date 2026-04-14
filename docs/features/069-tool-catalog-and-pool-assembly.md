# Feature 069: Tool Catalog And Pool Assembly

Status: `in_progress`  
Type: `P1 Runtime/Tools`

## Goal

把当前“静态注册全部 builtin tool”的模式升级为两层：

- `src/tools/catalog.ts`
- `src/tools/pool.ts`

让 runtime 不再直接把所有工具注册并暴露给模型，而是先通过 pool assembly 得到“当前会话真正可见的工具集合”。

## Why

这次改动的收益不是抽象本身，而是具体的 runtime 收益：

1. 降低工具 schema token 噪音，减少每轮 prompt 体积。
2. 让模型只看到当前 mode / policy 下真正可用的工具，降低误选率。
3. 保持工具顺序稳定，减少 prompt cache 抖动。
4. 为后续 MCP / extension / deferred tool 预留正确接入层。
5. 把“工具注册”和“工具暴露给模型”分开，避免以后继续堆在 registry 上。

## Scope

- In:
  - 新增 builtin catalog，列出全部 builtin tool 定义。
  - 新增 tool pool，根据 mode / policy 选择本轮可见工具。
  - `buildDefaultRegistry()` 改为消费 pool 输出，不再直接硬编码注册顺序。
  - runner / WeChat / E2E helper 改为通过 pool 构造 registry。
  - 新增 pool 级测试，覆盖过滤与稳定排序。
- Out:
  - 这次不接 MCP client。
  - 这次不做 deferred tool。
  - 这次不改 tool execution 协议。
  - 这次不引入复杂 deny-rule 语法。

## Current State

当前 `src/tools/builtin/index.ts` 直接：

- import 全部 builtin tool
- 用固定顺序 `registry.register(...)`
- runtime 统一看到完整工具集合

问题：

- mode 差异无法前置到工具可见性层
- policy 差异无法前置到模型可见性层
- 后续一旦接入 MCP，builtin 和外部工具会混在同一层

## Design

### 1. `src/tools/catalog.ts`

职责：

- 导出 `getBuiltinToolCatalog()`
- 返回完整 builtin tool definition 数组
- 是 builtin 工具清单的单一事实源

约束：

- 顺序固定
- 不在这里做过滤

### 2. `src/tools/pool.ts`

职责：

- 定义 `ToolPoolOptions`
- 提供 `assembleToolPool(options)`
- 根据 mode / policy / env 输出最终工具数组

首版先支持以下过滤维度：

#### mode

- `default`
- `wechat`

首版策略：

- `default`: 保留现有 builtin 集合
- `wechat`: 先显式去掉配置类工具，避免模型在 WeChat 会话里看到本地交互配置能力
  - `config`
  - `config_get`
  - `config_set`

说明：

- 这是保守首版，不追求一次做很多 mode。
- 先把 pool 层建立起来，后续再扩更多 mode 规则。

#### policy

新增简单策略位：

- `includeNames?: string[]`
- `excludeNames?: string[]`

行为：

- `includeNames` 非空时，只保留匹配工具
- 再应用 `excludeNames`

这能覆盖：

- 测试场景定制 pool
- 后续 feature flag / policy layer 适配
- 未来更细粒度 deny-rule 的落点

### 3. 排序策略

必须保证：

- builtin 工具顺序稳定
- pool 过滤后相对顺序不变
- 不做按名字重新排序

理由：

- 当前 prompt cache 的稳定性更依赖“相同集合的相同顺序”
- 未来接入 MCP 时，builtin prefix 需要保持连续

### 4. Registry 集成

`buildDefaultRegistry()` 改成：

- 调 `assembleToolPool({ mode: 'default' })`
- 把 pool 输出注册到 `ToolRegistry`

并新增：

- `buildRegistryFromPool(tools)`

让 runner / helper / tests 可以显式传 pool。

## Implementation Notes

- `catalog.ts` 只负责“全集”
- `pool.ts` 只负责“当前可见子集”
- `registry.ts` 仍保持简单，不承担过滤职责
- 过滤逻辑不下沉到 tool execute 阶段

## Files

- `src/tools/catalog.ts`
- `src/tools/pool.ts`
- `src/tools/builtin/index.ts`
- `src/runtime/runner.ts`
- `src/transport/wechat/run.ts`
- `tests/tool_pool.test.ts`
- `tests/tool_registry.test.ts`
- `tests/e2e/helpers.ts`

## Test Matrix

### Unit

- catalog returns stable builtin list
- pool default mode returns full builtin set
- pool wechat mode excludes config tools
- pool includeNames narrows visible tools
- pool excludeNames removes named tools
- pool preserves relative order after filtering
- buildRegistryFromPool registers only pooled tools

### Regression

- existing `tool_registry` tests stay green
- existing `executor` tests stay green
- existing runtime loop tests stay green

### E2E Sample

至少抽 2-3 个：

- `e2e_read`
- `e2e_session_resume`
- `e2e_orientation_inject`

目的：

- 确认默认 mode 的 pool 没破坏主 loop
- 确认 session / orientation 路径不受 registry 变更影响

## Acceptance Criteria

1. builtin 工具清单有单独 catalog。
2. runtime 不再直接依赖“硬编码 register 序列”，而是依赖 pool 输出。
3. pool 能按 mode / include / exclude 过滤。
4. 默认 mode 对现有 CLI 行为无回归。
5. 抽样 E2E 通过。

## Verification

- `node --experimental-strip-types --test tests/tool_pool.test.ts`
- `node --experimental-strip-types --test tests/tool_registry.test.ts`
- `node --experimental-strip-types --test tests/runtime_loop.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_read.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_session_resume.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_orientation_inject.test.ts`
