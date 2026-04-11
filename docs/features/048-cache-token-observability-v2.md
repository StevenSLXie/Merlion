# Feature 048: Cache & Token Observability V2

Status: `done`  
Type: `P0 observability`

## Goal

在 CLI 中提供高可观测的 cache/token 诊断，帮助快速判断：

- provider 是否给了 cache 命中
- 当前请求里哪些消息类型在吞 token（system/user/assistant/tool）
- 每轮 prompt 的稳定前缀是否足够大（cache 友好程度）

## Implementation

### Runtime metrics

- 新增 `src/runtime/prompt_observability.ts`
- 每轮 provider 调用前计算：
  - `estimated_input_tokens`
  - `tool_schema_tokens_estimate`
  - `role_tokens`（system/user/assistant/tool）
  - `role_delta_tokens`（相对上一轮增量）
  - `stable_prefix_tokens`
  - `stable_prefix_ratio`
  - `stable_prefix_hash`
- prompt tracker 在会话内跨轮复用（不在每个 runLoop 调用中重置）

### Loop hooks

- `runLoop` 新增 `onPromptObservability` 回调
- 在 compaction 之后、provider 调用之前触发，确保指标反映真实发出的 prompt

### CLI output

- `status` 行保留原有 usage 信息
- 新增 `prompt` 行，展示：
  - 估算输入 token
  - 按 role 拆分
  - 各 role 增量
  - 稳定前缀规模与占比
  - 本轮 provider cache 命中占比
  - 稳定前缀 hash

### Usage archive

- `.usage.jsonl` 追加 `prompt_observability` 字段（可选）

## Files

- `src/runtime/prompt_observability.ts`
- `src/runtime/loop.ts`
- `src/index.ts`
- `src/runtime/session.ts`
- `src/cli/status.ts`
- `src/cli/experience.ts`
- `tests/prompt_observability.test.ts`
- `tests/cli_status.test.ts`

## Verification

- `npm run typecheck`
- `npm test`
