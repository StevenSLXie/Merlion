# 079 Minimal Task Runtime

Status: `implemented`  
Type: `P1 Architecture`

## Goal

引入最小 `Task runtime`，把当前实际存在的多类执行单元从 callback/branch 逻辑中抽出来，变成统一注册、统一生命周期、统一终止语义的 task system。

## Why

Merlion 现在已经不只是“单次 prompt -> runLoop -> finish”：

- 本地 one-shot turn
- REPL 中连续 turns
- WeChat message handling
- verify / fix rounds
- 后续显式 skill activation / workflow / MCP action

如果没有 task runtime，这些流程会继续：

- 堆在 `runner.ts`
- 用 callback 串起来
- 难以统一取消、重试、超时和 terminal state

free-code 值得借鉴的点是：

- 有明确 `Task` 类型边界
- 有 `tasks.ts` 注册入口
- task 有状态与 identity

参考：

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/Task.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/tasks.ts`

## Scope

- 新增最小 task 抽象
- 覆盖当前真实场景：
  - local turn
  - wechat message
  - verify round
- 定义统一 task lifecycle

## Implementation Order

这份 spec 依赖 `078 QueryEngine` 先落地。

正确顺序是：

1. 先让 `QueryEngine` 成为 conversation owner
2. 再让 task runtime 调度 engine-backed execution

否则 task 只会继续调用 `runner`/`loop` 的旧接口，无法真正降低耦合。

## Non-Goals

- 不实现 worker swarm
- 不实现 distributed/remote task orchestration
- 不做复杂任务 DAG

## Implemented Files

- `src/runtime/tasks/types.ts`
- `src/runtime/tasks/registry.ts`
- `src/runtime/tasks/handlers/local_turn.ts`
- `src/runtime/tasks/handlers/wechat_message.ts`
- `src/runtime/tasks/handlers/verify_round.ts`

## Core Types

```ts
type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface RuntimeTask<Input, Output> {
  type: string
  id: string
  createdAt: string
  status: TaskStatus
  input: Input
  run(ctx: TaskContext): Promise<Output>
  cancel?(): Promise<void> | void
}
```

## TaskContext

`TaskContext` 不应直接等于 `ToolContext`。

建议包含：

- `engineFactory`
- `sessionStore`
- `sink`
- `permissions`
- `cwd`
- `abortSignal`
- `artifactServices`

这样 task 是 runtime 调度单元，engine 是会话执行单元，两者分层清楚。

## First Three Task Types

### 1. `local_turn`

输入：

- user prompt
- current session id
- mode flags

输出：

- `RunLoopResult`

用途：

- one-shot CLI
- REPL single message turn

### 2. `wechat_message`

输入：

- message payload
- thread/session linkage
- sender metadata

输出：

- normalized final text
- transport delivery decision

说明：

- Phase 1 里这类 task 重点是把“单条入站消息的处理”结构化
- WeChat poll loop 本身不一定要在这版进入 task runtime

### 3. `verify_round`

输入：

- target prompt or patch context
- check set
- max rounds

输出：

- verification summary
- fixed/failed terminal state

## Lifecycle Model

每个 task 至少统一这些行为：

1. create
2. mark running
3. emit `task_started`
4. execute
5. emit `task_completed` / `task_failed` / `task_cancelled`
6. surface terminal state to sink

## Cancellation Model

必须统一。

建议：

- task runtime 为每个 task 挂 `AbortController`
- task cancel 时：
  - 先 abort provider/tool execution
  - 再标记 task terminal

避免不同模式下取消语义不同。

## Retry / Timeout Model

不建议在 task handler 内各自定义。

建议 runtime 统一支持：

- optional `timeoutMs`
- optional retry policy

不同 task type 只声明策略，不自己实现定时器和重试器。

## Relationship with QueryEngine

建议职责分层：

- `Task runtime`
  - 调度什么任务
  - 管理任务状态
  - 统一取消/超时/重试
- `QueryEngine`
  - 承载一次 conversation 的消息、context、tool loop

也就是：

- task 是外层 orchestration
- engine 是内层 conversation execution

## Runner Simplification Target

当前 `runner.ts` 里很多逻辑属于：

- 判断现在是什么执行形态
- 决定运行哪个流程
- 接各种 hooks

task runtime 上线后，runner 应该更接近：

1. build dependencies
2. create task

## Phase 1 Implementation Note

本轮已落地最小 task runtime：

- `local_turn`
- `wechat_message`
- `verify_round`

当前实现重点是统一分发入口和 handler 边界，还没有继续上 `task id / cancel / timeout / retry policy` 的完整生命周期层。
3. dispatch task
4. hand result to sink

## Free-code Alignment

这块借 free-code 的关键不是要复制所有 task 类型，而是：

- 先承认“不是所有执行单元都是一个 loop”
- 把 runtime 里真实存在的任务类型显式化
- 让新能力以后接到 task runtime，而不是继续污染 runner

## Tests

- task registry 注册和按 type 分发
- local_turn task 正常完成
- verify_round task 超时/失败 terminal 一致
- cancel task 能终止 engine/provider
- same sink 可以消费不同 task type 的事件

## E2E

- REPL one turn task
- wechat message task
- verify round task

## Acceptance Criteria

1. 当前真实执行形态至少有 3 类进入 task runtime
2. `runner.ts` 与 WeChat message handler 不再手写大段分支编排
3. cancel / timeout / retry 语义统一
4. 后续 workflow / skill / MCP action 可以新增 task type，而不是继续写 callback

## Free-code References

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/Task.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/tasks.ts`
