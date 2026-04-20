# 096 Responses Provider And Item-Native Loop

Status: `proposed`  
Type: `P1 Inference Runtime`

## Goal

引入 OpenAI `ResponsesProvider`，并把 `runLoop()` / `QueryEngine` 的主执行路径改成 item-native loop。

迁移完成后：

- OpenAI 主路径默认可用 Responses API
- loop 直接消费 `ConversationItem[]`
- tool execution 产物以 `function_call_output` 回灌

## Why

只引入 item 类型还不够。

如果 loop 依旧按下面的老模式工作：

- provider 返回 `assistant message + tool_calls`
- executor 产出 `role: tool`
- transcript 继续当消息数组用

那么 runtime 只是“看起来支持 items”，本质上还是 Chat Completions 架构。

## Scope

- 新增 `ResponsesProvider`
- 改写 `runLoop()` 主状态为 item transcript
- 让 `QueryEngine` 持有 item state
- 保留 Chat provider adapter

## Non-Goals

- 本 spec 不解决 session 文件 cutover
- 本 spec 不彻底重写 compact
- 本 spec 不清理所有 synthetic runtime messages

## Provider Design

建议新增：

- `src/providers/openai_responses.ts`

保留：

- [src/providers/openai.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/providers/openai.ts:1)

### ResponsesProvider Responsibilities

1. 把 `ConversationItem[]` 转成 Responses API `input`
2. 把 Responses `output` / event stream 转回 `ConversationItem[]`
3. 记录 `providerResponseId`
4. 提供 usage / cached token 数据

### First Version Recommendation

第一版不要直接依赖 `previous_response_id` 作为唯一上下文机制。

建议：

- 先显式传入完整 item transcript
- 先保证行为正确
- 等 session / compact / observability 理顺后，再加 `previous_response_id` 优化

原因：

1. 更容易 debug
2. 更容易 resume
3. 更容易与现有本地 transcript 对齐

## Loop Redesign

### Current Shape

当前 loop 以 message 为中心：

- 发 messages
- 收 assistant message
- 读取 `tool_calls`
- 执行工具
- 追加 `role: tool`

### Target Shape

目标 loop：

1. provider 返回 `outputItems`
2. runtime 追加这些 items
3. 收集其中的 `function_call` items
4. 执行工具
5. 把结果追加成 `function_call_output` items
6. 继续调用 provider
7. 直到出现真正的 assistant final message

### Pseudocode

```ts
for (;;) {
  const response = await provider.completeItems(state.items, tools)
  state.items.push(...response.outputItems)

  const calls = collectFunctionCalls(response.outputItems)
  if (calls.length > 0) {
    const outputs = await executeCallsAsOutputItems(calls)
    state.items.push(...outputs)
    continue
  }

  const recovery = maybeRecoverStopOrLength(response, state)
  if (recovery.shouldContinue) {
    state.items.push(...recovery.injectedItems)
    continue
  }

  return finalizeFromItems(state.items, response)
}
```

上面这个伪代码只是主干，不代表“没有 function_call 就立即结束”。  
Merlion 当前已经有一套 stop-recovery 语义，这些行为在 item-native loop 里必须保留。

## Termination And Recovery Invariants

以下现有行为属于 runtime contract，不允许在迁移时丢失：

1. `finish_reason === 'length'` 时的续写恢复
2. tool 后空回答时，补一轮自然语言 summary request
3. 有工具执行但没有成功修改时，不允许过早结束
4. 有代码修改但没有验证痕迹时，补一轮 verification hint
5. “承诺会做事但没有调用工具”的 nudge 仍然保留

也就是说，item-native loop 必须表达：

- function_call chain
- normal final stop
- recoverable stop
- recoverable length

而不是把 termination 简化成“无 function_call 即终止”。

### Recovery Items

这些恢复动作在 item transcript 里仍然存在，但必须标注为 runtime 注入：

```ts
{
  kind: 'message',
  role: 'user',
  source: 'runtime',
  content: 'Output was cut off. Continue directly from where you stopped...'
}
```

这样：

- 行为不退化
- compact 不会把它误认成真实用户任务锚点
- 以后如果要把某些恢复提示迁出 transcript，也有清晰边界

## QueryEngine Changes

[src/runtime/query_engine.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/query_engine.ts:137) 应改成：

- 内部历史为 `ConversationItem[]`
- `contextService` 产出 item prelude，而不是 message prelude
- sink/UI 需要展示时，再投影成 render messages

### Important Constraint

`QueryEngine` 仍然是 conversation owner。

这次改造不应该把状态重新打散回 `runner`。

## Tool Execution Changes

`executor.ts` 的职责不变，但返回值要升级：

- 不再只返回 `ChatMessage`
- 返回 `FunctionCallOutputItem`
- 如需 UI payload，附加在 event channel，不混进 transcript source of truth

## Synthetic Runtime Guidance

当前 loop 中存在大量 injected messages：

- tool argument hints
- no-progress hints
- verification hints
- no-mutation hints

这一版不强行删除。

策略是：

1. 继续允许它们存在
2. 但把它们建模为 `message` items，且 `source: 'runtime'`
3. 后续再单独评估哪些应当从 transcript 内部挪出去

这样做的好处是：

- 迁移不阻塞
- exact-prefix 问题被显式化
- 第二轮优化有清晰目标

## Tests

### Unit

- Responses output -> ConversationItem parse
- function call -> function_call_output round trip
- legacy Chat provider adapter -> item transcript

### E2E

- OpenAI Responses path completes a tool-using task
- same task resume continues correctly
- item-native loop still supports verification and permissions
- length recovery still continues correctly
- empty post-tool stop still yields final summary
- no-mutation stop recovery still prevents premature completion
- weak-verification stop still triggers one extra recovery round

## Acceptance Criteria

1. OpenAI 路径可通过 Responses API 正常完成工具调用任务
2. `runLoop()` 不再以 `ChatMessage[]` 为核心 state
3. `QueryEngine` 以 item transcript 持有会话历史
4. Chat provider 仍可通过 adapter 运行
5. 当前 stop-recovery 语义不回退
