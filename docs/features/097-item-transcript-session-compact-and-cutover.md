# 097 Item Transcript Session Compact And Cutover

Status: `proposed`  
Type: `P1 Runtime Persistence`

## Goal

完成最后一段迁移：

- session transcript 升级为 item-native
- compact 升级为 item-aware
- observability 升级为 item-prefix aware
- OpenAI 默认路径切到 Responses

这份 spec 完成后，这次迁移才算真正结束。

## Why

如果：

- loop 已经是 item-native
- provider 已经支持 Responses

但：

- session 还只保存 messages
- compact 还按 messages 压
- observability 还只看 message signatures

那么 Merlion 还是会在长任务、resume、调试和 cache 纪律上退回旧世界。

## Scope

- 升级 `src/runtime/session.ts`
- 升级 `src/context/compact.ts`
- 升级 `src/runtime/prompt_observability.ts`
- 完成 OpenAI provider cutover

## Session Format

### Current Problem

[src/runtime/session.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/session.ts:1) 当前只存：

- `session_meta`
- `message`

这不足以恢复：

- reasoning items
- function_call / function_call_output chain
- future provider response ids

### Proposed Format

JSONL 中新增：

```ts
type TranscriptEntry =
  | SessionMetaEntry
  | TranscriptResponseEntry
  | TranscriptItemEntry
  | LegacyTranscriptMessageEntry

interface TranscriptResponseEntry {
  type: 'response'
  response: ProviderResponseBoundary
}

interface TranscriptItemEntry {
  type: 'item'
  item: ConversationItem
  origin: 'provider_output' | 'local_tool_output' | 'local_runtime'
  runtimeResponseId?: string
}
```

其中：

- `TranscriptResponseEntry` 记录 response-level metadata
- `TranscriptItemEntry.origin` 记录 item 的来源
- `TranscriptItemEntry.runtimeResponseId` 把 provider 输出 item 归属到某次 response

这两层都需要。

只写 `item: ConversationItem` 不够，因为那样无法稳定恢复：

- 最近一次 `providerResponseId`
- response 边界
- response 级 observability 关联
- future `previous_response_id` resume 优化
- 本地尾部 items 的确定性排序

### Compatibility

读取时：

- 同时支持 `type: 'message'`
- 同时支持 `type: 'item'`

对 `type: 'message'` 的 legacy entries：

- 必须通过 `095` 定义的 legacy source recovery 规则映射到 item transcript
- 不能只做字段级转抄
- 若 source 判定存在歧义，resume/compact 必须走更保守路径

写入时：

- 新 session 默认写 `item`
- 每次 provider 完成时，先写一条 `response`
- 再写本次 response 的 `item` entries，`origin='provider_output'`，并带 `runtimeResponseId`
- 旧 session 继续可读

### Response Boundary Rules

建议 session 持久化时遵守这个顺序：

```text
response entry
  -> item entry 1
  -> item entry 2
  -> ...
```

这样 resume 时可以可靠地拿到：

- 最新一次 runtime response
- 最新一次 provider response id
- 某组 items 属于哪次 inference

### Local Item Persistence Rules

除了 provider 输出，runtime 还会追加两类本地 item：

1. tool execution 产生的 `FunctionCallOutputItem`
2. recovery / hint / summary request 等 runtime 注入 message item

这些 item 的持久化规则必须固定：

- `local_tool_output`
  - `origin = 'local_tool_output'`
  - `runtimeResponseId` 为空
  - 在工具执行完成时，按原 `FunctionCallItem` 顺序立刻写入
- `local_runtime`
  - `origin = 'local_runtime'`
  - `runtimeResponseId` 为空
  - 在 runtime 决定注入恢复/提示 item 时立刻写入

最重要的约束是：

- transcript 是 append-only log
- 所有 entries 都按“运行时真实追加顺序”写入
- 不允许在持久化阶段为了分组美观，事后把 local items 挪回前一个 response 块内部

resume 时：

- JSONL 文件顺序就是唯一真序
- `response` entry 只定义 provider response 边界
- 不定义 local item 的从属关系
- local tail 是否存在，由读取最新 response 之后的 append-only items 判断

这样同一轮 turn 的序列化就不会因为实现风格不同而重排。

### `previous_response_id` Resume Eligibility

如果未来启用 `previous_response_id`，不能简单地“拿最新 providerResponseId 就继续”。

只有在下面条件同时成立时才安全：

1. 最新 `TranscriptResponseEntry` 存在 `providerResponseId`
2. 从这条 `response` 之后，到 transcript 末尾，没有任何未重放的 local items

这里的 local items 包括：

- `origin = 'local_tool_output'`
- `origin = 'local_runtime'`

因为这些 item 不属于 provider response 本身。

所以 resume 优化策略必须是：

1. 找到最新带 `providerResponseId` 的 `response` entry
2. 检查其后是否存在 local tail
3. 如果没有 local tail：
   - 可直接用 `previous_response_id`
4. 如果有 local tail，但实现支持安全 replay 这段尾巴：
   - 先用 `previous_response_id`
   - 再按原顺序 replay local tail
5. 如果不支持安全 replay：
   - 回退完整 transcript replay

第一版建议更保守：

- **只在“无 local tail”时启用 `previous_response_id`**
- 否则统一回退完整 transcript replay

这样不会丢本地尾巴。

如果未来启用 `previous_response_id` 的更激进模式：

- resume 时应优先读取最新的 `TranscriptResponseEntry.providerResponseId`
- 但前提必须满足上面的 eligibility 条件

## Compaction

### Current Problem

[src/context/compact.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/context/compact.ts:26) 现在的 compact：

- 只看 message 数组
- 保留第一个 system
- 保留最近 N 条
- 中间压一条自然语言 summary

这太粗。

### Target Rules

item-aware compaction 的第一版建议：

1. 永远保留：
   - system / developer equivalent prelude
   - 最近一个 `source: 'external'` 的 user request 之后的所有 items
2. 如果最近 external user request 后存在 function_call chain：
   - 保留从最近 external user item 到最近 function_call_output 的完整链
3. 更老的内容才允许压缩
4. reasoning items 优先跟随相邻 function call chain 一起保留

### Important Constraint

这里的锚点不能是“最后一条 role=user item”，因为当前 runtime 会持续注入内部 user 提示。

所以 compact 必须依赖 `MessageItem.source`：

- `source: 'external'` 才是任务锚点
- `source: 'runtime'` 只是恢复/纠偏辅助

否则会出现两类错误：

1. 误把最后一条 runtime 催促当成主任务
2. 错误地把整个尾部锁死，导致 compact 失效

这与 OpenAI 的建议一致：

- 自己裁剪时，至少保留最近用户消息到 function call output 之间的 items

Source:

- <https://platform.openai.com/docs/guides/reasoning/use-case-examples>

### Output Shape

compact 结果仍允许生成 summary item，但应显式建模，例如：

```ts
{
  kind: 'message',
  role: 'system',
  source: 'runtime',
  content: 'Conversation compact summary ...'
}
```

## Prompt Observability

### Current Problem

[src/runtime/prompt_observability.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/prompt_observability.ts:12) 现在通过 message signature 估算 stable prefix。

这会错过：

- reasoning item continuity
- function call / output chain continuity
- item-level cache value

### Target

升级为：

- item signature
- item role/type token breakdown
- stable item prefix count / tokens
- provider response id correlation

建议 observability snapshot 至少带：

- `runtimeResponseId`
- `providerResponseId`
- `stableItemPrefixCount`
- `stableItemPrefixTokens`

这样 observability 才能真正用于指导策略，而不仅是记录。

## Cutover

### OpenAI Default Path

当以下条件成立后：

1. ResponsesProvider e2e 稳定
2. session resume 支持 item transcript
3. compact item-aware
4. observability item-aware

就可以把 OpenAI 默认路径切到 Responses。

### Chat Provider Position

切换后：

- `OpenAICompatProvider` 保留
- 但定位变成 compatibility backend
- 不再决定 runtime 抽象

## Cleanup

cutover 完成后，应清理：

- `LoopState.messages` 之类旧字段
- any helper that assumes `role: tool` is transcript source
- session 中只写 message 的旧路径

不要求立刻删所有 adapter，但要把它们标注为 transitional。

## Acceptance Criteria

1. session transcript 默认写 item entries
2. old sessions still load
3. compact 至少能保留最近 external user -> function_call_output 链
4. observability 基于 item prefix 统计
5. OpenAI 默认路径切到 Responses
6. Chat Completions path 退居兼容层，而非主架构
