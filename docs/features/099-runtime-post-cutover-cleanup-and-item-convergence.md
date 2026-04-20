# 099 Runtime Post-Cutover Cleanup And Item Convergence

Status: `in-progress`  
Type: `P1 Runtime Hygiene`

## Goal

在 `094`-`097` 完成 item-native cutover 之后，继续做一轮收口，把运行时从“已经能用 item 跑通”收敛到“内部模型单一、残留兼容层受控、明显死代码清空、核心模块更容易继续演进”。

这份 spec 关注四件事：

1. 删除已经确认没有生产调用方的 runtime dead code
2. 明确 `ConversationItem[]` 是内部唯一 source of truth
3. 在表示收敛之后拆分 `runLoop()` / `QueryEngine.submitPrompt()`
4. 把 `findProjectRoot()` 从局部复制状态收敛成单一实现

## Why Now

`094`-`097` 已经把 Merlion 的主执行路径切到 item-native world，但当前仓库仍保留几类“迁移后残留”：

- 一些 runtime state bucket 已经没有生产调用方
- 一些 message-native helper 只被测试覆盖，生产路径已经不再依赖
- `runLoop()` 和 `QueryEngine.submitPrompt()` 仍同时承担 item orchestration、兼容投影、artifact maintenance 等多重职责
- `findProjectRoot()` 一部分消费者已经共用 `agents.ts` 导出，但仍有多个文件保留本地副本

这些问题单看都不致命，但会持续放大后续改动成本：

1. 删除无用状态会更安全
2. 统一内部表示会让 loop 拆分更容易
3. 基础 helper 只有一个实现，后续规则调整才不会漏改

## Current Findings

### 1. Confirmed Dead Runtime State

当前已经确认以下状态/辅助函数没有生产调用方：

- `src/runtime/state/skills.ts`
- `src/runtime/state/memory.ts`
- `src/runtime/state/types.ts` 中的 `skills` / `memory` snapshot fields
- `src/runtime/state/types.ts` 中的 `compact.replayedInjectedMessages`
- `src/runtime/state/compact.ts` 中的 `recordReplayInjectedMessages()`

这些代码目前只是在 state 定义内部自循环，不参与真实 runtime 行为。

### 2. Message-Native Compact Residue

`src/context/compact.ts` 同时保留：

- `estimateMessagesChars()` / `compactMessages()`
- `estimateItemsChars()` / `compactItems()`

但生产路径实际只使用 item-native 版本；message-native 版本当前只在测试中被调用。

这说明：

- 要么 message-native compact 已经不再是 runtime contract
- 要么它应该被明确降级为 compatibility/test helper，而不是继续看起来像主路径能力

### 3. Mixed Internal Representation Still Leaks Upward

虽然运行主路径已经可以使用 `ConversationItem[]`，但 runtime 内部仍保留大量：

- `items -> messages`
- `messages -> items`
- item state + message projection 并存

这种双表示会继续放大：

- `runLoop()` 的状态复杂度
- `QueryEngine.submitPrompt()` 的 orchestration 成本
- session / sink / local turn 的边界判断

### 4. Project Root Resolution Is Only Partially Converged

当前 `findProjectRoot()` 的影响范围不是只有“4 处定义”。

#### Local Definitions

- `src/artifacts/agents.ts`
- `src/runtime/session.ts`
- `src/artifacts/progress.ts`
- `src/artifacts/codebase_index.ts`

#### Additional Import Consumers

- `src/context/path_guidance.ts`
- `src/artifacts/guidance_staleness.ts`
- `src/artifacts/progress_auto.ts`
- `src/context/orientation.ts`
- `src/artifacts/agents_bootstrap.ts`

这意味着真正的变更面是：

- 4 个重复实现
- 5 个额外消费者

因此这不是一个“顺手清理”的小重构，需要按 shared helper 迁移来处理。

## Non-Goals

- 不在这份 spec 里重新设计 provider API
- 不把 CLI / WeChat sink 一次性重写成纯 item event stream
- 不在第一步顺手改变 session 文件格式
- 不为“删死代码”引入新的抽象层
- 不在 `findProjectRoot()` 收敛时顺手改动 unrelated artifact policies

## Design

### 1. Remove Confirmed Dead Runtime State First

第一步只做低风险、可验证的删除。

应删除：

- `src/runtime/state/skills.ts`
- `src/runtime/state/memory.ts`
- `RuntimeState` / `RuntimeStateSnapshot` 中无生产用途的 `skills` / `memory`
- `CompactState.replayedInjectedMessages`
- `recordReplayInjectedMessages()`

对应要求：

- 删除后 `QueryEngine.getSnapshot()` 仍应稳定工作
- 不允许留下空壳字段继续占据 runtime contract
- 测试应改为验证“当前真实存在的 runtime state”，而不是为死字段续命

### 2. Converge Internal Runtime State Fully Onto `ConversationItem[]`

在本轮 cleanup 之后，Merlion 应明确区分两类表示：

#### Internal Source Of Truth

- `ConversationItem[]`

#### Boundary / Compatibility Projection

- `ChatMessage[]`

`ChatMessage` 可以继续存在，但只应服务：

- UI 渲染
- compatibility provider adapter
- REPL / sink display projection
- legacy tests still anchored on message rendering

不应继续作为以下模块的内部主状态：

- `runLoop()`
- `QueryEngine`
- item-native session resume path
- compact trigger decision

设计原则：

1. 内部状态只维护 items
2. message 只在边界上投影生成
3. 不再为了“兼容旧接口”让核心模块长期双写双读

### 3. Reclassify Or Remove Message-Native Compact Helpers

`src/context/compact.ts` 需要明确归位。

有两种合法结果：

1. 如果 message-native compact 不再有生产价值，直接删除 `estimateMessagesChars()` / `compactMessages()`
2. 如果仍需保留 legacy support，把它们显式标成 compatibility helper，并避免与 item-native 主路径混在一起

推荐方向是第一种：删除生产无调用方的 message-native compact，并把相关测试改为 item-native 行为测试。

### 4. Split Runtime Orchestration Only After Representation Convergence

`runLoop()` 和 `QueryEngine.submitPrompt()` 的拆分应放在内部表示收敛之后，而不是之前。

原因：

- 如果双表示还在，拆出来的模块仍会夹带 conversion glue
- 那样只会把复杂度从一个大函数摊到多个中函数，而不是实质降低复杂度

#### `runLoop()` Target Shape

应把当前逻辑拆成几个清晰阶段：

1. provider turn execution
2. tool batch execution
3. tool outcome analysis and hint injection
4. stop/length/content-filter recovery
5. finalization

这些阶段之间应通过显式的 item-native state 和 analysis result 传递，而不是继续共享大量局部计数器。

#### `QueryEngine.submitPrompt()` Target Shape

应把当前“大提交函数”拆成：

1. prelude assembly
2. loop invocation
3. post-run artifact maintenance
4. sink notification
5. runtime state synchronization

尤其是：

- codebase index update
- progress auto-update
- guidance staleness detection
- generated map refresh

应进入一个明确的 post-run maintenance stage。

### 5. Consolidate `findProjectRoot()` Into One Shared Helper

等上面的清理和表示收敛完成后，再统一 project-root resolution。

建议新增一个共享 helper 模块，例如：

- `src/artifacts/project_root.ts`

它应承载：

- `fileExists()`
- `findProjectRoot()`

然后：

1. 先把四个本地定义迁移到共享 helper
2. 再让 import 消费方统一指向共享实现
3. 最后删除 `agents.ts` 内仅为 root discovery 暴露的重复基础逻辑

这个步骤开始前，应先做一次全量 `rg findProjectRoot`，确保没有遗漏使用面。

### 6. Compiler-Level Hygiene Is Part Of The Work, Not Follow-Up Polish

这轮 cleanup 应顺手清掉编译器已经能确认的 unused residue：

- unused imports
- unused locals
- unused parameters

目标不是追求 style perfection，而是确保“迁移残留”不会继续假装自己是活代码。

## Rollout Order

推荐按下面的顺序落地：

1. ✅ 删除确认无生产调用方的 dead runtime state
2. ✅ 清掉 compiler-confirmed unused imports / locals
3. 进一步把内部 runtime state 收敛到 `ConversationItem[]`
4. 在表示单一后拆 `runLoop()` / `QueryEngine.submitPrompt()`
5. ✅ 最后统一 `findProjectRoot()` shared helper

这个顺序的关键不是保守，而是避免在双表示尚存时提前拆函数，导致 refactor 只搬运复杂度。

## Files

### Dead Code / State Cleanup

- `src/runtime/state/types.ts`
- `src/runtime/state/compact.ts`
- `src/runtime/state/skills.ts`
- `src/runtime/state/memory.ts`
- `src/runtime/query_engine.ts`
- `tests/query_engine.test.ts`

### Representation Convergence

- `src/runtime/loop.ts`
- `src/runtime/query_engine.ts`
- `src/context/compact.ts`
- `src/runtime/items.ts`
- `src/runtime/session.ts`
- `src/runtime/runner.ts`
- `src/runtime/local_turn.ts`
- `src/runtime/sinks/cli.ts`
- related runtime / compact / session tests

### Project Root Helper Convergence

- `src/artifacts/agents.ts`
- `src/artifacts/progress.ts`
- `src/artifacts/codebase_index.ts`
- `src/runtime/session.ts`
- `src/context/path_guidance.ts`
- `src/context/orientation.ts`
- `src/artifacts/guidance_staleness.ts`
- `src/artifacts/progress_auto.ts`
- `src/artifacts/agents_bootstrap.ts`

## Validation

### Unit

- runtime state snapshot no longer exposes deleted dead fields
- item-native compact still behaves correctly after message-native residue removal
- `runLoop()` still recovers correctly for `tool_calls`, `length`, and `stop`
- post-run maintenance still updates artifacts under the same conditions
- all `findProjectRoot()` call sites resolve the same root after helper convergence

### Integration

- session resume still reconstructs working item transcript
- REPL and single-shot runtime still render expected output after message projection is pushed to boundaries
- context/orientation/path-guidance still build against the shared project root helper

### Hygiene Gates

- `tsc --noEmit`
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`
- targeted runtime / compact / session / artifact tests

## Completed Work

### Phase 1/2/5 — Dead Code, Unused Imports, Project Root (done)

- Deleted `src/runtime/state/skills.ts` and `src/runtime/state/memory.ts`
- Removed `SkillState`, `MemoryState`, `skills`, `memory` from `RuntimeState` / `RuntimeStateSnapshot`
- Removed `CompactState.replayedInjectedMessages` and `recordReplayInjectedMessages()`
- Removed message-native `estimateMessagesChars()` / `compactMessages()` from `src/context/compact.ts`
- Updated `tests/compact.test.ts` to cover item-native behavior only
- Cleaned compiler-confirmed unused imports in `runner.ts`, `loop.ts`, `loop_guardrails.ts`, `compact.ts`, `agents_bootstrap.ts`, `input_buffer.ts`
- Created `src/artifacts/project_root.ts` with canonical `fileExists()` + `findProjectRoot()`
- Migrated all 4 local definitions and 5 import consumers to the shared helper
- Removed dead re-export from `agents.ts`
- Renamed `lastCompactBoundaryMessageCount` → `lastCompactBoundaryCount` to remove stale "message" semantics

## Acceptance Criteria

1. Confirmed dead runtime state is deleted, not merely deprecated.
2. `ConversationItem[]` is the only internal runtime source of truth.
3. Message-native compact helpers are either removed or explicitly demoted to compatibility-only status.
4. `runLoop()` and `QueryEngine.submitPrompt()` are decomposed after representation convergence, not before.
5. `findProjectRoot()` has a single shared implementation, with all current call sites migrated.
6. The cleanup passes compiler unused checks and relevant runtime tests.
