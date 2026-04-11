# Feature 030: Core Types + Transcript Hardening (M1-01)

Status: `done`  
Type: `P0 core`

## Goal

完成 `M1-01`：补齐全局共享类型，并把 transcript 读取改成严格校验，避免脏数据污染恢复会话。

## Scope

1. 在 `src/types.ts` 增加 session/transcript 相关共享类型
2. `src/runtime/session.ts` 解析 JSONL 时进行结构与 role 校验
3. 非法行（坏 JSON、非法 role、错误结构）自动忽略

## Exit Criteria

- `src/types.ts` 拥有 transcript/session 基础类型定义
- `loadSessionMessages` 只返回合法 `ChatMessage`
- 新增测试覆盖“非法行过滤”场景
