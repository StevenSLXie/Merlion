# 081 Context Service And Trust-Gated Prefetch

Status: `implemented`  
Type: `P1 Runtime Efficiency`

## Goal

把当前零散的 orientation / prompt sections / AGENTS / git snapshot / path guidance 组织成统一 `ContextService`，并引入 trust-gated prefetch 机制，让昂贵上下文只在安全条件下预取、缓存、复用。

## Why

Merlion 现在已经有不少 context 相关模块：

- orientation
- prompt sections
- AGENTS maps
- codebase index
- path guidance
- git status snapshot

但问题是：

1. 上下文来源很多，缺少统一 owner
2. preload / cache / invalidation 规则分散
3. 哪些东西可以在 session 启动时预取，哪些只能按需读，还没有正式 policy

free-code 的关键设计是：

- 把 system context 与 user context 分层
- 做 memoized caching
- startup 时对某些上下文做并行预取
- 但只在 safe / trusted 条件下做

参考：

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/context.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/main.tsx`

## Scope

- 新增统一 `ContextService`
- 引入 context layer 分类
- 引入 trust-gated prefetch policy
- 统一 invalidation 与 cache key

## Implementation Order

`ContextService` 不应该独立落在 `runner` 里。

Phase 1 的合理落点是：

1. 由 `runner` 在 session/bootstrap 阶段创建 `ContextService`
2. 由 `QueryEngine` 调用它获取 system/session-turn context
3. task runtime 与 transports 只消费结果，不自己拼装 context

## Non-Goals

- 不重做整个 orientation 内容
- 不实现远程 memory service
- 不一次性把所有 artifact 都改成异步 daemon

## Implemented Files

- `src/context/service.ts`
- `src/context/cache_keys.ts`
- `src/context/policies.ts`

现有文件整合：

- `src/context/orientation.ts`
- `src/context/path_guidance.ts`
- `src/prompt/system_prompt.ts`
- `src/prompt/sections.ts`
- `src/artifacts/*`

## Context Layers

建议至少分 4 层：

### 1. Static system context

- runtime rules
- tool contract
- workspace scope

### 2. Session-stable context

- git status snapshot
- AGENTS summary
- codebase index summary
- orientation snapshot

### 3. Turn-evolving context

- path guidance deltas
- skill activation payload
- verification feedback

### 4. Local-only runtime context

- CLI mode
- transport mode
- trust level

## ContextService API

```ts
interface ContextService {
  getSystemContext(engine: QueryEngine): Promise<ResolvedContext>
  getUserContext(engine: QueryEngine): Promise<ResolvedContext>
  prefetchIfSafe(engine: QueryEngine): Promise<void>
  invalidate(keys: string[]): void
}
```

## Prefetch Policy

预取不应默认对所有环境都做。

建议加 policy：

- trusted workspace 才允许：
  - git snapshot prefetch
  - AGENTS map preload
  - codebase index preload
- untrusted workspace：
  - 只允许无副作用轻量信息

## Trust Model

这一版只需要最小 trust signal：

- local workspace
- current permission mode
- optional future `requiresTrustedWorkspace`

重点不是安全绝对正确，而是让 harness 自己不要无脑预取。

## Invalidation

必须显式化。

例如：

- 文件变更后，path guidance / codebase index cache 失效
- commit 后，git snapshot 失效
- skill activation 后，turn context 增量更新

不要继续把失效逻辑散落在 runner callback。

## Relationship with Prompt Cache

这块和 prompt cache 直接相关。

统一 context service 的收益之一是：

- 哪些 section 稳定
- 哪些 section 会变
- 哪些 section 可以放在 cache-friendly prefix

这对 token 成本和 provider cache 命中率都重要。

## Free-code Alignment

借鉴重点：

1. system/user context 分层
2. startup prefetch 但受 safety/trust 约束
3. context caching 是 runtime service，不是 incidental helper

## Tests

- trusted workspace 会预取 git/orientation/index
- untrusted workspace 不做高成本预取
- file change 触发 context invalidation
- repeated turn 复用 cache 而不重复计算

## E2E

- startup context reuse
- path guidance after mutation

## Acceptance Criteria

1. context 有统一 service owner
2. prefetch 行为由 policy 决定，不再散落在入口和 runner
3. cache / invalidation / prompt assembly 有统一接缝

## Phase 1 Implementation Note

本轮 `ContextService` 已作为统一 owner 接管：

- system prompt 缓存
- startup prefetch
- trust level policy
- path guidance 增量消息构造

当前 trust policy 仍是最小版，主要依据 permission mode 和 `MERLION_TRUST_WORKSPACE` 环境变量，不是完整的 workspace trust framework。

## Free-code References

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/context.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/main.tsx`
