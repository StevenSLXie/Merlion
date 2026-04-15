# 078 QueryEngine Conversation Runtime

Status: `implemented`  
Type: `P1 Architecture`

## Goal

引入 `QueryEngine`，把一次会话内的 agent loop 状态、上下文附着、权限结果、compaction 恢复、skill/memory 发现等横切状态，从当前的 `runLoop() + runner callback` 组合里收拢为一个 conversation-scoped runtime object。

目标不是抽象层数更多，而是让“一个会话的生命周期”有唯一状态所有者。

## Why

当前 Merlion 的结构是：

- `src/runtime/loop.ts`
  - 负责 turn loop、tool execution、一些恢复逻辑
- `src/runtime/runner.ts`
  - 负责 session、orientation、artifact 更新、sink、usage、path guidance
- 另外再通过 `onMessageAppended / onToolBatchComplete / onUsage` 等 callback 拼装行为

这样的问题是：

1. conversation state 分散
   - message state 在 loop
   - artifact/runtime side effects 在 runner
   - tool visibility / prompt observability / path guidance / verification 通过 callback 注入
2. 后续接 skill / MCP / task / richer permission policy 时，状态归属会继续恶化
3. compact / resume / replay 仍偏函数式，缺少正式的会话 owner

free-code 的关键思路不是“loop 更复杂”，而是有一个 per-conversation `QueryEngine` 持有：

- query lifecycle
- runtime mutable state
- tool visibility
- permission wrapper
- dynamic attachments
- memory/skill discovery
- abort / cancellation 句柄

参考：

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`

## Scope

- 新增 `src/runtime/query_engine.ts`
- 把当前 conversation-scoped 状态收敛进 `QueryEngine`
- `runLoop()` 保留，但降级为 engine 内部 primitive
- `runner.ts` 改成构造 engine + 调用 engine 的薄编排层

## Implementation Order

这份 spec 不能孤立实现。

按实际依赖，应该和以下 spec 一起推进：

1. `082` 先定义 runtime state slices
2. `078` 以这些 state slices 为底座引入 `QueryEngine`
3. `081` 让 engine 不再直接拼 context
4. `080` 让 engine 接收统一 input envelope
5. `079` 最后把 engine 纳入 task runtime

也就是说，`QueryEngine` 是这组改造的 spine，不是独立 feature。

## Non-Goals

- 不在这一版直接实现多 agent
- 不在这一版直接实现 full task runtime
- 不强行重写 session 文件格式
- 不把 CLI / WeChat sink 重做一遍

## Design Principles

1. 一个会话只对应一个 `QueryEngine` 实例
2. 所有会话内可变状态，优先归 `QueryEngine`
3. `runner` 只做 bootstrap / dependency wiring / mode selection
4. `loop` 不再承担“长期状态仓库”的职责
5. 对外 API 必须足够小，避免再造一个 God object

## Implemented Files

- `src/runtime/query_engine.ts`
- `src/runtime/state/types.ts`
- `src/runtime/state/permissions.ts`
- `src/runtime/state/compact.ts`

现有文件调整：

- `src/runtime/runner.ts`
- `src/runtime/loop.ts`
- `src/transport/wechat/run.ts`

## State Ownership

### QueryEngine 应持有的状态

- `sessionId`
- `cwd`
- `provider`
- `registry`
- `permissions`
- `messages`
- `turnCount`
- `usageTracker`
- `promptObservabilityTracker`
- `pathGuidanceState`
- `discoveredSkillNames`（先预留）
- `loadedMemoryPaths`（先预留）
- `deniedToolCalls`
- `hasAttemptedCompact`
- `abortController`

### 不应归 QueryEngine 的状态

- CLI 渲染状态
- WeChat transport 状态
- config wizard 临时状态
- process-global cache

## External API

建议最小 API：

```ts
interface QueryEngineOptions {
  cwd: string
  sessionId: string
  provider: ModelProvider
  registry: ToolRegistry
  permissions: PermissionStore
  sink?: RuntimeEventSink
  sessionStore: SessionStore
  orientation: OrientationPayload
  intentContract?: string
}

class QueryEngine {
  constructor(options: QueryEngineOptions)

  submitUserMessage(input: UserInputEnvelope): Promise<RunResult>
  resumeFromTranscript(messages: ChatMessage[]): Promise<void>
  compactIfNeeded(): Promise<void>
  abort(): void
  getSnapshot(): QueryEngineSnapshot
}
```

## Internal Method Layout

建议内部拆成这些阶段方法：

- `prepareTurnInput()`
- `resolveVisibleTools()`
- `buildRequestMessages()`
- `completeOneTurn()`
- `executeToolBatch()`
- `applyPostToolEffects()`
- `recoverFromStopIfNeeded()`
- `persistMessages()`

这样保留当前 `runLoop()` 的执行逻辑，但状态从函数局部挪到 engine 实例。

## Relationship with runLoop

这一版不要直接删 `runLoop()`。

建议路径：

1. 先让 `runLoop()` 变成 `QueryEngine` 内部调用的 primitive
2. `runner` 先改成创建 engine 并调用 `submitUserMessage()`
3. 等 task runtime 上线后，再决定 `runLoop()` 是否继续保留为测试 helper

## Session / Resume

当前 resume 行为主要在：

- `src/runtime/session.ts`
- `src/runtime/runner.ts`

重构后应改为：

1. `runner` 负责取 transcript
2. `QueryEngine.resumeFromTranscript(messages)` 恢复内部 message state
3. 后续 compact / replay / skill reattach 都通过 engine 完成

## Event Flow

现在 runtime 事件大多是 callback：

- `onTurnStart`
- `onAssistantResponse`
- `onToolCallStart`
- `onToolCallResult`
- `onToolBatchComplete`

这套接口短期先保留，但 owner 改成 `QueryEngine`。

也就是：

- engine 产生 typed runtime events
- sink 订阅事件
- runner 只负责连接二者

## Free-code Alignment

这份 spec 要借 free-code 的不是具体函数名，而是这几个结构思想：

1. 会话有唯一 engine owner
2. engine 负责 query lifecycle，而不是 runner 层 callback 杂糅
3. tool / context / permission / dynamic attachments 都归 engine
4. future features 都是往 engine state 扩，而不是继续往入口加 callback

## Migration Plan

### Phase 1

- 新增 `QueryEngine`
- 把 `messages / turnCount / usage / prompt observability / permission bookkeeping / compact bookkeeping` 搬进去
- runner 改为调用 engine

### Phase 1 Implementation Note

本轮已按 Phase 1 落地：

- `QueryEngine` 成为 conversation-scoped owner
- `runner` 与 `wechat` transport 改为组装并调用 engine
- `runLoop()` 保留为 engine 内部 primitive
- permission / compact bookkeeping 已接入 `RuntimeState`
- REPL 和 WeChat 的主 turn 执行改为通过 engine

### Phase 2

- 把 path guidance、tool denial、compact recovery 搬进去

### Phase 3

- skill/memory/runtime attachments 接入 engine state

## Tests

- `QueryEngine.submitUserMessage()` 能跑通单轮与多轮 tool loop
- resume 后 turnCount / messages / usage 连续
- engine abort 能终止当前 provider/tool execution
- compact 后 snapshot 一致
- runner 只做 wiring，不再承担状态逻辑

## E2E

- session resume
- compact recovery
- path guidance update after tool batch

## Acceptance Criteria

1. `runner.ts` 不再直接持有核心会话状态
2. conversation-scoped mutable state 有统一 owner
3. resume / compact / tool-denial recovery 有稳定接入点
4. 后续 task runtime / skill runtime 不需要继续往 `runner` 堆 callback

## Free-code References

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/main.tsx`
