# 094 Responses Item Runtime Migration

Status: `proposed`  
Type: `P1 Architecture`

## Goal

把 Merlion 从当前的 `ChatMessage[]` + `/chat/completions` runtime，完整迁移到以 `ConversationItem[]` 为核心、以 Responses API 为 OpenAI 主路径的 agent runtime。

目标不是“多支持一个 provider”，而是让运行时的数据模型与现代 agent transcript 对齐：

- `message`
- `reasoning`
- `function_call`
- `function_call_output`

迁移完成后：

1. OpenAI 路径默认走 Responses API
2. runtime 的 source of truth 不再是 `ChatMessage[]`，而是 `ConversationItem[]`
3. session / resume / compact / observability 都以 item transcript 为主
4. 现有 CLI / WeChat / builtin tools / verification 能力不丢
5. 兼容层短期保留，但不再决定架构

## Why

当前 Merlion 最大的结构性短板不是功能少，而是 transcript 模型偏旧。

现在的核心路径是：

- provider 接 `/chat/completions`
- loop 以 `ChatMessage[]` 为主
- transcript 持久化只记录 message
- compact 只理解 message

这会带来三个问题：

1. 无法保留 reasoning items
2. 无法原生表达 `function_call` / `function_call_output`
3. 很难把“稳定前缀”“保留最近 action-observation 链”变成 runtime 的一等原则

OpenAI 当前官方建议已经很明确：

- Responses API 是新 agent 的推荐路径
- reasoning models 在 Responses API 下可以保留 reasoning/tool context
- 如果要自己管理上下文，至少要保留“最近用户消息到最近 function call output 之间”的 item 链
- Chat Completions 是 stateless，不会把 reasoning items 带回后续上下文

Sources:

- <https://platform.openai.com/docs/guides/responses-vs-chat-completions>
- <https://platform.openai.com/docs/guides/reasoning-best-practices>
- <https://platform.openai.com/docs/guides/reasoning/use-case-examples>
- <https://openai.com/index/unrolling-the-codex-agent-loop/>

## Design Principles

1. 先升级 transcript 数据模型，再升级 provider
2. 先允许 dual-stack，最后再 cut over
3. 运行时主干保持简单，不在迁移中继续加新 addon
4. compatibility layer 是过渡手段，不是最终架构
5. 最终 runtime 只保留一个 source of truth

## Final Architecture

最终形态应是：

- `ConversationItem[]` 是 runtime state、session transcript、compaction、resume 的唯一主表示
- OpenAI 相关推理/工具链路默认走 Responses API
- loop 处理 item 流，不再把 tool call 塞回 assistant message
- UI 层如需渲染 message，可以从 item 投影出 renderable events
- compact 按 item 边界工作，而不是只按 message 压缩

### Primary Runtime Flow

```text
user input
  -> context prelude items
  -> provider.completeItems(items, tools)
  -> provider returns output items
  -> append output items
  -> if function_call items exist:
       execute tools
       append function_call_output items
       continue
  -> if final assistant message exists:
       stop
```

## Non-Goals

- 不在这组 spec 里引入多 agent
- 不顺手重写 sink/CLI 展示系统
- 不在第一阶段追求 Codex 完整级别的 exact-prefix discipline
- 不强行把所有非 OpenAI provider 一次性升级到 Responses 兼容

## Required Specs

这次迁移拆成三份子 spec：

1. `095` Conversation Items And Provider Capabilities
2. `096` Responses Provider And Item-Native Loop
3. `097` Item Transcript Session Compact And Cutover

## Migration Strategy

### Phase 1: Data Model First

目标：

- 引入 `ConversationItem`
- 让 runtime 可以同时持有 item transcript 和 message projection
- 不改变现有外部功能面

结果：

- `ChatMessage[]` 不再是 source of truth
- 现有 provider 仍可工作

### Phase 2: Responses Provider

目标：

- 增加 `ResponsesProvider`
- 让 OpenAI 路径可以走 item-native inference

结果：

- OpenAI provider 能返回 reasoning / function_call / function_call_output
- runtime 不需要把这些强行降级回 message 才能继续

### Phase 3: Item-Native Runtime

目标：

- loop、session、compact、resume 以 item transcript 为主
- message 只作为 UI / compatibility 视图

结果：

- compaction 可以保留关键 action-observation 段
- observability 可以按 item prefix 计算

### Phase 4: Cutover

目标：

- OpenAI 默认使用 Responses API
- Chat provider 降级为 compatibility backend
- 移除不再需要的 message-first runtime assumptions

结果：

- Merlion 的架构主路径与 Codex / Responses item model 对齐

## Complexity

总体复杂度：`medium-high but controlled`

不是小改，因为会触发：

- core types
- provider interface
- loop state
- transcript persistence
- compaction
- observability

但它不是推倒重来，因为：

- `QueryEngine`
- `runLoop`
- `executor`
- `session`

这些边界已经存在，适合做增量迁移。

## Proposed Order

1. 先落 `095`
2. 再落 `096`
3. 然后落 `097`
4. 最后做 cutover 收尾

建议拆成两个连续的小 PR：

1. `097` 主实现 PR
   - session
   - compact
   - observability
   - cutover readiness checks
2. cutover PR
   - 把 OpenAI 默认入口切到 Responses
   - 保留 Chat provider compatibility path

也就是说：

- cutover 仍属于 `097` 的收尾范围
- 但实际代码变更建议分成独立小 PR，避免把 persistence/compact 改动和默认 provider 切换绑死在一次提交里

## Acceptance Criteria

1. OpenAI 主路径不再依赖 `/chat/completions`
2. runtime 主状态不再是 `ChatMessage[]`
3. session transcript 能恢复 item 链，而不仅是 message
4. compact 能保留最近 action-observation 链
5. CLI / REPL / WeChat / verification 行为不回退
