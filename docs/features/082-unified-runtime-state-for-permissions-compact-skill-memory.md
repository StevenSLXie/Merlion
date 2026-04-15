# 082 Unified Runtime State For Permissions Compact Skill Memory

Status: `implemented`  
Type: `P1 Runtime State`

## Goal

把当前以及未来会继续扩张的横切 runtime concerns：

- permission outcomes
- compaction state
- skill discovery/activation
- memory attachment/load state

统一收进一个明确的 runtime state model，而不是继续散在 `loop.ts`、`runner.ts`、tool execution 和 future skill logic 中。

## Why

这几类能力有共同特点：

1. 都不是单一工具的局部逻辑
2. 都会跨 turn 持续影响 agent 行为
3. 都需要在 compact / resume 后保持一致
4. 都很容易变成 callback 污染源

free-code 的真正可借鉴点是：

- permission 不是只在工具里 ask 一下
- skill / memory 不是纯 prompt 文本，而是 runtime state
- compact 不是独立 helper，而是会话状态的一部分

参考：

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/context.ts`

## Scope

- 定义 unified runtime state slices
- 给 `QueryEngine` 提供明确的 state modules
- 为 future skill/memory 实现留 state 接缝

## Implementation Order

这是 `78-82` 的底座。

Phase 1 必须先把：

- `PermissionState`
- `CompactState`

正式接入运行路径。

`SkillState` / `MemoryState` 这版可以先以真实数据结构落地，但只做：

- state owner
- snapshot
- replay 接缝预留

不要求本轮就产生复杂行为。

## Non-Goals

- 不在本 spec 里实现完整 skill runtime
- 不在本 spec 里实现 MCP
- 不直接改 session transcript 格式，除非为 state replay 必须

## Proposed Files

- `src/runtime/state/types.ts`
- `src/runtime/state/permissions.ts`
- `src/runtime/state/compact.ts`
- `src/runtime/state/skills.ts`
- `src/runtime/state/memory.ts`

## State Slices

### PermissionState

至少记录：

- denied tool names
- denied tool call signatures
- session-allow grants
- last permission prompt result

用途：

- 避免模型反复撞 deny
- 后续更好的 denied-action feedback

### CompactState

至少记录：

- whether compact already attempted
- last compact boundary
- replay markers
- summary artifact references

用途：

- compact 不只是“执行过没有”，还要支持恢复和解释

### SkillState

至少记录：

- discovered skills
- activated skills
- injected skill payload ids
- activation counts

用途：

- 避免重复注入
- compact/resume 后可恢复 skill presence

### MemoryState

至少记录：

- loaded memory paths
- nested memory expansions
- source provenance

用途：

- 避免反复 attach 同一 memory
- 给 future memory/skill progressive disclosure 做基础

## QueryEngine Integration

建议 `QueryEngine` 内部持有：

```ts
interface RuntimeState {
  permissions: PermissionState
  compact: CompactState
  skills: SkillState
  memory: MemoryState
}
```

每个 slice 独立演进，但统一归 engine 管。

## Permission Flow

当前问题是：

- 有些 permission 在 tool 内部询问
- 有些可见性在 pool 预过滤
- denied outcome 没有很好进入后续 runtime reasoning

建议改成：

1. pool 负责注入前预过滤
2. engine 负责 query-level deny bookkeeping
3. tool 只做实际 ask/execute 边界

## Compact Flow

当前 compact 更接近“消息压缩算法”。

建议升级为 runtime state 之后：

1. compact 决策记录在 `CompactState`
2. compact 后需要知道哪些 state slices 要 replay
3. future skill/memory 注入能在 compact 后恢复

## Skill / Memory Flow

即便这两块暂时没正式实现，state 设计也应该先立住。

因为一旦没有状态层，后面最容易退化成：

- 再往 prompt 里硬塞内容
- 再往 runner callback 里塞逻辑

## Free-code Alignment

要借鉴的是：

1. skill/memory 是 runtime state，不是 prompt text blob
2. permission outcomes 要进入会话状态
3. compact 后的会话行为需要 replay-aware

## Tests

- denied tool bookkeeping 不丢失
- compact state 能记录并用于恢复
- activated skill state 防止重复注入
- loaded memory paths 去重

## E2E

- denied tool then recovery
- compact then continue
- explicit skill activation then later turn reuse

## Acceptance Criteria

1. permission / compact / skill / memory 有明确 state slice
2. 这些 concerns 不再继续堆在 runner/loop callback
3. future skill/memory/MCP 接入不需要重新定义状态归属

## Phase 1 Implementation Note

本轮已把以下 slices 正式接入运行路径：

- `PermissionState`
- `CompactState`

同时已落地真实但轻量的：

- `SkillState`
- `MemoryState`

后两者当前主要用于 snapshot / 去重 / 后续 replay 接缝预留，还没有完整 skill 或 memory runtime 行为。

## Free-code References

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/context.ts`
