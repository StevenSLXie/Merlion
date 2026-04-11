# Feature 026: Compact Summary (M4-02)

Status: `done`  
Type: `P0 context control`

## Goal

当会话上下文膨胀时，自动进行一次轻量 compact，降低上下文体积并减少 token 消耗。

## Scope

1. 触发条件：消息总字符数超过阈值
2. compact 方式：保留系统消息 + 最近 N 条消息，历史中段压缩为一条 summary system message
3. guard：每个会话最多自动 compact 一次，防止循环 compact

## Config

- `MERLION_COMPACT_TRIGGER_CHARS` (default `60000`)
- `MERLION_COMPACT_KEEP_RECENT` (default `10`)

## API

- `compactMessages(messages, options?)`
- runtime loop 内部自动触发

## Test Plan

- compact 后消息体积下降
- 保留最近消息
- 会话最多 compact 一次

## Exit Criteria

- runLoop 可在长上下文下自动 compact
- 单测与 typecheck 通过
