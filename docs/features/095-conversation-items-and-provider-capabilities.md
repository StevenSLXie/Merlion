# 095 Conversation Items And Provider Capabilities

Status: `proposed`  
Type: `P1 Runtime Core`

## Goal

定义 Merlion 的新核心 transcript 类型 `ConversationItem`，并重构 provider interface，使 runtime 可以同时支持：

- item-native providers
- legacy message-based providers

这份 spec 是整个迁移的底座。

## Why

现在的核心类型定义在 [src/types.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/types.ts:1)：

- `ChatMessage`
- `AssistantResponse`
- `ModelProvider.complete(messages, tools)`

这套抽象把 runtime 锁在了 Chat Completions 的 message world 里。

问题不在 message 本身，而在它无法自然表达：

- `reasoning`
- `function_call`
- `function_call_output`
- future item-level metadata

## Scope

- 更新 `src/types.ts`
- 引入 `ConversationItem`
- 引入 provider capability model
- 保留 `ChatMessage` 作为 compatibility/render type

## Non-Goals

- 本 spec 不直接改 Responses HTTP 调用
- 本 spec 不直接改 loop 行为
- 本 spec 不直接切 session 文件格式

## Proposed Types

建议把 `ChatMessage` 和 `ConversationItem` 分开。

### Render Type

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}
```

这个类型继续服务：

- UI 渲染
- compatibility adapters
- docs/examples

### Runtime Transcript Type

```ts
export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | SystemMessageItem
  | ReasoningItem
  | FunctionCallItem
  | FunctionCallOutputItem

export interface UserMessageItem {
  kind: 'message'
  role: 'user'
  content: string
  source: 'external' | 'runtime'
  itemId?: string
}

export interface AssistantMessageItem {
  kind: 'message'
  role: 'assistant'
  content: string
  source: 'provider'
  itemId?: string
}

export interface SystemMessageItem {
  kind: 'message'
  role: 'system'
  content: string
  source: 'static' | 'runtime'
  itemId?: string
}

export interface ReasoningItem {
  kind: 'reasoning'
  itemId?: string
  summaryText?: string
  encryptedContent?: string
}

export interface FunctionCallItem {
  kind: 'function_call'
  itemId?: string
  callId: string
  name: string
  argumentsText: string
}

export interface FunctionCallOutputItem {
  kind: 'function_call_output'
  itemId?: string
  callId: string
  outputText: string
  isError?: boolean
}
```

说明：

- `content` / `argumentsText` / `outputText` 先保持字符串，先求稳定，不先做过度结构化
- `UserMessageItem.source` 用来区分真实用户输入与 runtime 注入消息，compact 锚点依赖它
- `AssistantMessageItem.source` 固定为 `provider`，避免 adapter 各自发挥
- `SystemMessageItem.source` 区分静态前缀与 runtime 注入 system guidance
- `itemId` 是 provider 返回的稳定标识，后续 resume / exact-prefix / debug 时有用
- `encryptedContent` 保留给 Responses reasoning item

## Per-Role Message Semantics

为了避免不同 adapter 对 `source` 自由发挥，role 语义必须固定：

### User Message

- `role: 'user', source: 'external'`
  - 真实用户输入
  - resume / compact 的任务锚点
- `role: 'user', source: 'runtime'`
  - loop 恢复提示
  - verification hint
  - no-progress / no-mutation / summary request

### Assistant Message

- `role: 'assistant', source: 'provider'`
  - provider 产出的可见 assistant 内容
  - 不允许标成 `runtime`

### System Message

- `role: 'system', source: 'static'`
  - base system prompt
  - stable orientation / initial prelude
- `role: 'system', source: 'runtime'`
  - 后续注入的 path guidance
  - compact summary
  - 临时执行约束

如果后续发现某类 message 还需要更细分类，再扩枚举；当前不允许实现层自行引入隐含语义。

## Provider Interface

### Current Problem

当前接口：

```ts
interface ModelProvider {
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>
}
```

这让 provider 层决定了 runtime transcript 形态。

### Proposed Interface

```ts
interface ProviderCapabilities {
  transcriptMode: 'items' | 'messages'
  supportsReasoningItems: boolean
  supportsPreviousResponseId: boolean
}

interface ProviderResult {
  outputItems: ConversationItem[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: Usage
  providerResponseId?: string
  responseBoundary?: ProviderResponseBoundary
}

interface ModelProvider {
  capabilities(): ProviderCapabilities
  completeItems(items: ConversationItem[], tools: ToolDefinition[]): Promise<ProviderResult>
  setMaxOutputTokens?(tokens: number): void
}
```

### Response Boundary Metadata

provider 返回的不只是 items，还要有 response-level metadata。

建议定义：

```ts
interface ProviderResponseBoundary {
  runtimeResponseId: string
  providerResponseId?: string
  provider: string
  model?: string
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  outputItemCount: number
  createdAt: string
}
```

原因：

- session 需要稳定恢复 provider response 边界
- future `previous_response_id` 需要 resume 时知道最近一次 provider response
- observability 需要按 response 关联，而不是只靠 turn 猜

`runtimeResponseId` 是 Merlion 自己生成的稳定本地 id，避免 provider 无响应 id 时整个链路失去锚点。

## Compatibility Strategy

为了降低迁移风险，允许 provider 分两类：

### Item-native Provider

- 输入 `ConversationItem[]`
- 输出 `ConversationItem[]`
- 典型实现：Responses API

### Legacy Message Provider

- 内部仍然使用 `ChatMessage[]`
- 对外通过 adapter 暴露 `completeItems()`

也就是说：

- runtime 只认 `ConversationItem[]`
- provider 可在内部自己转换

## Legacy Transcript Source Recovery

除了 legacy provider adapter，还需要定义 legacy session transcript 的回填规则。

原因是旧 transcript 里的 `type: 'message'` entry 只有：

- `role`
- `content`
- `tool_calls`
- `tool_call_id`
- `name`

没有任何 `source` 元数据。

而新的 item runtime 里：

- compact 锚点依赖 `UserMessageItem.source`
- system prefix 稳定性依赖 `SystemMessageItem.source`

所以“旧 session 可读”不能只停留在语法层，必须有语义回填规则。

### Fallback Mapping Rules

legacy `message` -> item 时，默认按下面规则归类：

#### `role: 'assistant'`

- 一律映射为 `AssistantMessageItem`
- `source = 'provider'`

#### `role: 'tool'`

- 不直接映射为 message item
- 优先按 `tool_call_id` 转成 `FunctionCallOutputItem`
- 若无法恢复 `callId` 语义，则作为 legacy transcript parse failure 处理，并回退到 compatibility replay 路径

#### `role: 'system'`

- 第一条 system message：
  - 默认 `source = 'static'`
- 后续 system message：
  - 默认 `source = 'runtime'`

这是保守规则。

理由：

- 旧 runtime 中真正稳定的 system 前缀通常在最前面
- 之后插入的 system 内容更可能是 path guidance、contract、compact summary 等运行时附着物

#### `role: 'user'`

- 默认 `source = 'external'`
- 但如果 message content 命中已知 runtime-injected patterns，则回填为 `source = 'runtime'`

### Legacy Runtime-Injected User Heuristics

旧 transcript 中的 `role: 'user'` 存在两类来源：

1. 真实用户输入
2. 旧 runtime 注入的恢复/纠偏消息

第一版允许使用保守启发式识别第二类。

建议把以下前缀或固定模板视为 legacy runtime messages：

- `Output was cut off. Continue directly from where you stopped.`
- `You just finished tool execution. Please provide a natural-language final summary`
- `You have not made any successful file changes yet. Do not finish now.`
- verification hint 固定模板
- no-progress / no-mutation / exploration-budget / todo-drift 固定模板
- tool argument correction / repeated tool error hint 固定模板

要求：

- 这些模板必须集中定义在一个 legacy transcript classifier 中
- 不能分散在各个 adapter 里各自猜

### Safety Rule

如果 legacy classifier 无法高置信度判断某条 `role: 'user'` 是否为 runtime 注入：

- 默认归类为 `source = 'external'`

原因：

- 这会让 compact 更保守，而不是误删真实任务锚点
- 宁可少 compact，也不要把用户任务错当 runtime 尾巴

### Legacy Session Resume Mode

对旧 session，第一版不要求达到与新 item transcript 完全等价的恢复精度。

要求是：

1. 能稳定读取
2. 能生成保守、可继续运行的 item transcript
3. compact/resume 策略在遇到 legacy ambiguity 时偏保守

也就是说：

- legacy transcript 可读
- 但不要求 legacy transcript 直接享受最激进的 `previous_response_id` 优化
- 当 source 判定存在歧义时，应回退更保守的 replay / compaction 策略

## Required Adapters

新增一组纯函数：

- `messageToItems(message: ChatMessage): ConversationItem[]`
- `itemsToRenderableMessages(items: ConversationItem[]): ChatMessage[]`
- `toolCallToFunctionCallItem(call: ToolCall): FunctionCallItem`
- `toolResultToOutputItem(message: ChatMessage): FunctionCallOutputItem | null`

这组 adapter 是过渡期的关键。

## Canonicalization Rules

legacy message provider 转 item 时，必须有唯一规范顺序。

### Assistant Message With `content + tool_calls`

如果一个 assistant 响应同时包含：

- 可见文本内容
- 一个或多个 `tool_calls`

则 canonical form 必须是：

1. 如果 `content` 非空，先产出一个 `AssistantMessageItem`
2. 再按 provider 返回顺序，依次产出 `FunctionCallItem[]`

也就是：

```text
assistant message item
  -> function_call item 1
  -> function_call item 2
  -> ...
```

不能允许不同 adapter 一会儿产出：

- `message -> function_call`

一会儿产出：

- `function_call -> message`

否则：

- stable prefix 会漂移
- compact hash 不稳定
- resume 后 transcript 无法做可靠对比

### Empty Assistant Content With Tool Calls

如果 assistant `content` 为空或只含空白，且存在 `tool_calls`：

- 不生成空的 assistant `MessageItem`
- 只生成 `FunctionCallItem[]`

### Tool Output Canonicalization

tool execution 回灌 transcript 时：

- 必须按原 `FunctionCallItem` 顺序写入 `FunctionCallOutputItem[]`
- 必须保留 `callId`
- 不允许为了 UI 方便再额外产出 `role: tool` transcript source item

`role: tool` 只允许存在于 render projection，不再是 runtime transcript 真源。

## File Plan

建议新增：

- `src/runtime/items.ts`
- `src/runtime/item_adapters.ts`

建议调整：

- [src/types.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/types.ts:1)
- provider implementations
- any helper that assumes `LoopState.messages`

## Runtime State Change

`LoopState` 应从：

```ts
messages: ChatMessage[]
```

改成：

```ts
items: ConversationItem[]
```

如果某层暂时还需要 message 视图：

- 临时现场投影
- 不再把 projection 写回 source state

## Acceptance Criteria

1. runtime core type 可以表达 reasoning / function_call / function_call_output
2. provider interface 不再强制 message-only
3. compatibility adapters 存在且单测覆盖
4. `ChatMessage` 降级为 render/compat type，而不是 transcript source of truth
