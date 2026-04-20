# 098 Subagent Runtime V1

Status: `implemented`  
Type: `P1 Runtime Architecture`

## Goal

为 Merlion 设计第一版 subagent runtime。

目标不是一次性做成复杂 multi-agent 平台，而是为 coding-agent 场景增加一层**克制、可解释、可演进**的 delegation 能力：

1. 主 agent 能把明确的子任务委派给专门角色
2. 子任务有独立 transcript、独立生命周期、独立结果边界
3. 子任务不会默认把大量中间过程污染回主上下文
4. 角色数量少，模式清晰，不把系统带进 free-code 那种过重的 orchestration 复杂度

## Why

Merlion 当前已经具备：

- item-native transcript
- Responses-based OpenAI path
- session / resume / compact / observability 主干

这意味着我们已经有了构建 subagent 所需的几个关键前提：

- 可以把 child transcript 作为独立会话持久化
- 可以明确 parent / child 的 response boundary
- 可以把 child 结果作为结构化 artifact 回传，而不是强行塞进 parent transcript

在 coding-agent 里，subagent 的真正价值不是“多一个脑子”，而是：

1. 独立上下文边界
2. 独立 token 预算
3. 独立工作空间
4. 明确的结果回传协议

这正好对应了 Merlion 当前最在意的三件事：

- context discipline
- runtime clarity
- production usefulness

## External Reference Points

### Codex

Codex 官方文档给了几个很明确的约束：

- subagent 只在**明确要求**时 spawn
- subagent 继承 parent 的 sandbox / approvals
- built-in agents 很少，只提供：
  - `default`
  - `worker`
  - `explorer`
- custom agents 应该 narrow and opinionated
- `max_depth` 默认是 `1`

这说明 Codex 的核心设计取向是：

- 角色少
- orchestration 重于 agent zoo
- delegation 是昂贵能力，不应默认泛滥

### free-code

free-code 的价值不在于“角色很多”，而在于它已经证明了几种真实有效的模式：

- worker 可以异步后台执行
- child transcript 单独持久化
- parent 只拿到 task notification / summary / result
- background worker 可以 later continue
- 大规模写入任务可以 worktree isolation

但 free-code 也暴露了代价：

- task 类型膨胀
- session / resume / mailbox / worktree / UI / analytics 强耦合
- 多种 spawn 模式快速放大实现复杂度

Merlion 应该吸收它的 runtime lessons，而不是复制它的系统重量。

## Design Principles

1. 先做 coding-agent 真正需要的 delegation，不做通用 multi-agent 平台
2. 角色数量保持最小，不把模式混进角色名
3. 对模型暴露为 tool surface，对 runtime 内部实现为 first-class primitive
4. child 默认不继承完整 transcript，而继承结构化 briefing
5. child 默认把**结果摘要**回给 parent，而不是把完整过程塞回主上下文
6. depth 和 concurrency 从第一天起就受控
7. background、worktree、resume 都应是显式模式，而不是隐式副作用

## Non-Goals

- 不做 swarm / teammate mailbox / recursive multi-agent teams
- 不做 remote agent / cloud worker
- 不做十几个前后端/安全/DevOps 角色
- 不在 v1 默认支持 full transcript fork
- 不让 subagent 默认递归 spawn 其他 subagent

## Required Roles

Merlion v1 只支持三个 first-class roles：

### `explorer`

定位：读多写少的代码探索 agent。

职责：

- tracing code paths
- locating files / symbols / tests
- summarizing impact areas
- gathering evidence before edits

默认约束：

- read-only
- no file writes
- no commits
- no final user-facing answer beyond structured findings

### `worker`

定位：执行型 implementation agent。

职责：

- bounded code changes
- targeted bug fixes
- adding or updating tests
- small refactors with explicit scope

默认约束：

- writable
- can run tests and shell commands
- should report changed files and verification steps

### `verifier`

定位：独立验证 agent。

职责：

- adversarial verification
- regression hunting
- checking tests / commands / claims
- returning a verdict, not implementing features

默认约束：

- read-only by default
- no production code edits
- may run tests, diffs, read/search, and non-destructive shell commands

### Why `verifier` instead of `reviewer`

Codex built-ins 只有 `worker` 和 `explorer`，没有 `verifier`。

但 Codex 官方的 custom-agent 示例明确给出了 reviewer 型角色：

- `pr_explorer`
- `reviewer`
- `docs_researcher`

其中 `reviewer` 的职责是：

- correctness
- security
- behavior regressions
- missing tests

Merlion 选择 `verifier` 这个名字，是为了更清楚地表达它在 runtime 里的职责：

- 它是一个 verdict-producing gate
- 它不是泛泛地“提意见”
- 它主要回答“是否真的成立”

## Subagent Trigger Model

### Core Decision

subagent 对模型来说必须表现为 tool；
对 runtime 来说必须表现为 first-class primitive。

也就是说：

- **外部像 tool**
- **内部不是普通 tool**

原因很简单：

- 模型必须能在推理中主动决定是否委派
- 但 subagent 不是“一次输入、一次输出”的普通函数调用
- 它有独立 session、独立 transcript、独立身份、独立生命周期

因此，Merlion 不应把 subagent 实现成一个简单的 plugin tool handler。
它应由 runtime 直接管理，只是在 tool catalog 中暴露为 built-in agent tools。

## Tool Surface

### V1 Required

1. `spawn_agent`
2. `wait_agent`

### V1.5 / P2

3. `send_agent`
4. `stop_agent`

### Why not one generic `agent(...)`

subagent 的核心不是“能起一个 child”，而是它有生命周期：

- spawn
- run
- optionally background
- wait
- optionally continue
- optionally stop

把这些全塞进一个普通 tool 会让 parent/child 状态混乱，也不利于 transcript 和 session 设计。

### Capacity Limit Behavior

当 parent 已达到 `maxConcurrentChildren` 时，`spawn_agent` 不排队，不隐式等待。

V1 规则是：

- 直接拒绝新的 child spawn
- 返回结构化 rejection result，而不是默默排队

建议返回：

```ts
interface SpawnAgentRejectedResult {
  status: 'rejected'
  reason: 'capacity_limit_exceeded'
  maxConcurrentChildren: number
  runningChildren: number
  suggestedRetryAfterSeconds: number
}
```

这样 parent 模型可以：

- 等一会再试
- 先 `wait_agent`
- 或停止继续 fan-out

V1 不做内部排队。

## Execution Dimensions

subagent 设计里有四个互相独立的维度。

这些维度不能混进 `role`，否则系统会很快失控。

### 1. Role

- `explorer`
- `worker`
- `verifier`

### 2. Execution Mode

- `foreground`
- `background`

### 3. Context Mode

- `briefed`
- `fresh`
- `full_fork`

### 4. Isolation

- `same_dir`
- `worktree`

## V1 Supported Combinations

Merlion v1 不支持任意组合。

只支持这四种：

1. `explorer + foreground + briefed + same_dir`
2. `worker + foreground + briefed + same_dir`
3. `verifier + foreground + briefed + same_dir`
4. `worker + background + briefed + same_dir`

## Child System Prompt Model

child 行为不能只靠 briefing。

V1 必须明确区分两层：

1. **role system prompt**
2. **task briefing**

### Role system prompt

这是 child 的静态高优先级行为约束。

按 role 固定生成，例如：

- `explorer`
  - read-only
  - gather evidence
  - cite files / symbols / tests
  - do not propose edits unless asked

- `worker`
  - implement bounded task
  - stay within write scope
  - report changed files and checks run

- `verifier`
  - do not implement
  - independently test claims
  - return structured verdict

### Task briefing

这是 runtime 针对本次 spawn 注入的 task-specific context：

- task
- relevant paths
- changed files
- constraints
- verification target

### Priority

优先级必须明确：

1. role system prompt
2. task briefing
3. child transcript continuation

也就是说：

- child 的身份和边界来自 role system prompt
- child 这次具体做什么来自 briefing

briefing 不能替代 role system prompt。

## Execution Mode Semantics

### `foreground`

含义：

- parent tool call 阻塞
- runtime 等 child 完成
- tool 直接返回 child 的结构化结果

适合：

- exploration findings
- verification verdicts
- bounded implementation tasks where parent immediately depends on result

### `background`

含义：

- `spawn_agent` 立即返回 `agent_id` 和 running status
- child 在后台继续执行
- parent 可继续当前 loop
- parent 之后通过 `wait_agent` 获取结果

适合：

- 较长的 implementation 任务
- 不需要立即读取 child 中间过程的任务

### Why `background` only for `worker` in V1

- `explorer` 的结果通常立即决定下一步策略
- `verifier` 是 gate，通常天然阻塞
- 真正最适合后台的是长时间写代码或跑验证命令的 `worker`

## Context Mode Semantics

### `briefed`

默认模式，也是 V1 唯一实现模式。

child 不直接继承 parent transcript。
parent runtime 生成一份结构化 briefing，作为 child 的起始上下文。

优点：

- 上下文干净
- token 成本可控
- 不把 parent transcript 垃圾带进去
- 更符合 Merlion 的 context discipline

### `fresh`

不继承 parent transcript，也不带 parent synthesis，只给 task prompt 和 role contract。

V1 不实现，但 schema 允许预留。

### `full_fork`

尽量完整继承 parent transcript。

V1 明确不做。

原因：

- context 污染最大
- cache 纪律最差
- compact / resume / observability 会立刻变复杂

## Briefing Contract

`briefed` 模式下，child 的初始上下文应来自结构化 briefing，而不是 parent transcript 直拷。

### Required Fields

```ts
interface AgentBriefing {
  parentSessionId: string
  parentAgentId?: string
  role: 'explorer' | 'worker' | 'verifier'
  originalUserRequest: string
  rootUserRequest?: string
  task: string
  purpose?: string
  parentSummary?: string
  relevantPaths?: string[]
  changedFiles?: string[]
  constraints?: string[]
  writeScope?: string[]
  verificationTarget?: {
    changedFiles: string[]
    acceptanceCriteria?: string[]
  }
}
```

`parentAgentId` 仅用于 tracing / audit / future compatibility。
它不意味着 V1 允许递归嵌套；`maxDepth=1` 仍然生效。

## Briefing Generation Responsibility

### Core Rule

briefing 的 source of truth 是 **runtime**，不是 tool caller 直接拼装的自由文本。

也就是说：

- 模型通过 `spawn_agent` 表达委派意图
- runtime 根据当前 parent session 状态生成结构化 briefing
- child 启动时拿到的是 runtime 组装后的 briefing items

这样做是为了避免两个问题：

1. 把 parent transcript 的结构化状态丢回给模型临时发挥
2. 让不同实现者各自决定 relevant paths / changed files / constraints 从哪里来

### Spawn Tool Input vs Runtime-Enriched Briefing

`SpawnAgentInput` 只表达**模型显式知道并决定的东西**：

- `role`
- `task`
- `execution`
- `purpose`
- `writeScope`

`AgentBriefing` 则包含两部分：

1. tool input 直接携带的字段
2. runtime 从 parent state 自动补全的字段

### Runtime-Enriched Fields

运行时必须自动补全这些字段：

- `originalUserRequest`
- `rootUserRequest`
- `parentSummary`
- `relevantPaths`
- `changedFiles`
- `constraints`
- `verificationTarget`

### Runtime Enrichment Sources

V1 的生成规则固定如下：

#### `originalUserRequest`

来源：

- **触发本次 spawn 的最近外部用户请求**

它不是 session 第一条用户消息。
在多轮对话里，它应指向当前 child 任务真正服务的那条外部用户请求。

#### `rootUserRequest`

来源：

- 当前 session 的第一条外部用户请求

它只用于补充长期背景，不应覆盖 `originalUserRequest` 的优先级。

#### `parentSummary`

来源：

- 当前 parent runtime 的最近工作摘要
- 若没有显式摘要，则可为空

#### `relevantPaths`

来源按优先级：

1. `writeScope`
2. 当前 turn 的 path guidance / prompt-derived target paths
3. 最近一轮 tool path signals
4. 最近变更文件

V1 不要求完美覆盖，只要求 deterministic、可解释。

#### `changedFiles`

来源：

- parent 当前 session 已知的 changed files 集合
- 如当前任务还没有文件变更，可为空

#### `constraints`

来源：

- parent 当前 turn 的 intent contract
- 当前 permission / sandbox 约束的可见摘要
- role-specific contract

#### `verificationTarget`

仅对 `verifier` 必填。

来源：

- `changedFiles`
- parent 指定的 acceptance criteria
- 若 acceptance criteria 缺失，则至少包含“验证这些变更是否成立”

### Why not let the model fill all briefing fields

因为 `briefed` 模式的目的就是：

- 不让 child 直接继承 parent transcript
- 也不让 parent 模型重新自由转述整个 parent state

briefing 是 runtime 产物，不是 prompt prose。

### `task` vs `purpose`

这两个字段必须区分：

- `task`
  - child 需要执行的具体工作
  - 应该是可执行指令
  - 例如：`trace the request path for /login and identify where the session can become null`

- `purpose`
  - parent 为什么要发起这个 child
  - 主要用于帮助 child 校准输出粒度和重点
  - 例如：`this will be used to plan a targeted fix`

简单说：

- `task` = 做什么
- `purpose` = 为什么做

如果 `purpose` 缺失，child 仍然应能执行；
如果 `task` 缺失，则 `spawn_agent` schema 不成立。

### Role-Specific Expectations

#### Explorer briefing

必须强调：

- read-only
- gather evidence
- cite paths / symbols / tests
- avoid speculative fixes unless asked

#### Worker briefing

必须强调：

- exact task
- write scope
- constraints
- expected verification steps

#### Verifier briefing

必须强调：

- changed files
- what claim is being checked
- required commands / tests if known
- output must end in structured verdict

## Isolation Semantics

### `same_dir`

child 与 parent 共享仓库目录。

V1 默认使用这个模式。

原因：

- 复杂度最低
- 不需要立即引入 worktree lifecycle
- 先把 agent lifecycle 跑通

### `worktree`

child 在独立 git worktree 中运行。

这个模式非常适合：

- 大规模并行写任务
- 多 worker 改不同文件区域
- branch / PR 级别任务

但 V1 不实现。

原因：

- 需要引入 worktree create / cleanup / resume / disk mapping
- 会显著放大 session、task 和 cleanup 复杂度

## Result Return Contract

### Core Rule

child 默认回给 parent 的是**结构化结果摘要**，不是完整 transcript。

完整 transcript：

- 单独保存在 child session
- parent 只在需要时显式查看

### Required Result Shape

```ts
type AgentVerdict = 'pass' | 'fail' | 'partial' | 'not_applicable'

interface AgentRunResult {
  agentId: string
  role: 'explorer' | 'worker' | 'verifier'
  status: 'completed' | 'failed' | 'stopped' | 'running'
  summary: string
  finalText?: string
  filesRead?: string[]
  filesChanged?: string[]
  commandsRun?: string[]
  transcriptPath: string
  usage?: {
    promptTokens: number
    completionTokens: number
    cachedTokens?: number | null
  }
  verification?: {
    verdict: AgentVerdict
    notes?: string[]
  }
}
```

### `summary` vs `finalText`

这两个字段必须严格区分：

- `finalText`
  - child 最后一条 assistant 文本输出
  - 尽量原样保留
  - 可以为空

- `summary`
  - runtime-facing concise summary
  - 用于 parent orchestration、notification 和任务列表
  - 必须短于 `finalText`
  - 若 `finalText` 很长，`summary` 应是其压缩版

简单说：

- `finalText` 是 child 自己说的话
- `summary` 是 runtime 拿来调度的结果摘要

### `filesRead` / `filesChanged` semantics

这两个字段虽然是 optional，但不能语义含糊。

V1 规则：

- `undefined`
  - runtime 没有可靠收集到该字段
- `[]`
  - runtime 明确知道 child 没有读 / 改任何文件
- `['...']`
  - runtime 收集到了具体文件列表

也就是说：

- `undefined` = unknown
- `[]` = known empty

parent orchestration 不能把这两种情况混为一谈。

### Summary Generation Responsibility

和 briefing 一样，`summary` 的 source of truth 也必须明确。

V1 规则：

- `finalText` 来自 child 最后一条 assistant 文本
- `summary` 由 runtime 生成

也就是说，`summary` 不是简单假设为 `finalText` 的前几句。

### Summary generation inputs

runtime 生成 `summary` 时可使用：

- child terminal status
- child finalText
- changed files / commands run
- verifier verdict
- timeout / error reason

### Failure summary rule

当 `status='failed'` 时，`summary` 仍然必须存在。

它应优先表达：

- failed 的原因
- 当前是否产生了部分有用结果
- transcript 是否可供后续检查

例如：

- `worker failed: timeout after 900s; partial transcript preserved`
- `verifier failed: pytest command crashed before verdict`

`failed` 结果不能把 `summary` 留空并把理解负担全推给 `finalText` 或 transcript。

### Why structured result matters

如果 parent 只拿到一段自由文本：

- 很难做可靠的 orchestration
- 很难做 wait/resume
- 很难做 verifier gate
- 很难做 UI、audit 和 e2e

Merlion 应从第一天就把 child 当 task runtime，而不是“聊天分身”。

## Tool API

### `spawn_agent`

```ts
interface SpawnAgentInput {
  role: 'explorer' | 'worker' | 'verifier'
  task: string
  execution?: 'foreground' | 'background'
  purpose?: string
  writeScope?: string[]
  model?: string
  timeoutMs?: number
}
```

#### Foreground behavior

- runtime 创建 child session
- child 执行到 terminal status
- tool 返回完整 `AgentRunResult`

#### Background behavior

- runtime 创建 child session
- child 异步运行
- tool 立即返回：

```ts
interface SpawnAgentBackgroundResult {
  agentId: string
  role: 'explorer' | 'worker' | 'verifier'
  status: 'running'
  summary: string
  transcriptPath: string
}
```

### Model Selection

`SpawnAgentInput.model` 在 V1 预留，但不是必须由模型每次填写。

V1 的默认策略是：

- 未指定时，child 继承 parent model
- runtime 可以按 role 应用配置层默认值

也就是说，后续允许这种覆盖顺序：

1. tool call 显式指定 `model`
2. role-specific runtime config
3. parent model inheritance

这样可以支持：

- `explorer` / `verifier` 用更便宜模型
- `worker` 继承 parent 主模型

但不会把模型选择逻辑硬编码进 role taxonomy。

### Timeout

`SpawnAgentInput.timeoutMs` 在 V1 必须支持。

原因：

- background worker 不能无限挂起
- foreground child 也不能无限阻塞 parent

默认策略：

- 未指定时，使用 role-specific runtime default
- runtime 必须设置全局上限，防止异常超大值

建议默认值：

- `explorer`: `300000` ms
- `worker`: `900000` ms
- `verifier`: `600000` ms

timeout 到达时：

- child terminal status 记为 `failed`
- error reason 标记为 timeout
- transcript 保留
- `wait_agent` / foreground result 都返回结构化失败结果

### Why `contextMode` and `isolation` are not tool inputs in V1

V1 里：

- context mode 只有 `briefed`
- isolation 只有 `same_dir`

因此它们不应暴露在 `SpawnAgentInput` 里。

原因：

- 只有一个合法值的字段对调用方是噪音
- 也会错误暗示“还有别的稳定选项可以填”

V1 中：

- `briefed` 是 runtime 固定策略
- `same_dir` 是 runtime 固定策略

等到后续版本真正支持 `fresh` / `full_fork` 或 `worktree` 时，再把它们升级为显式 tool 参数。

### `wait_agent`

```ts
interface WaitAgentInput {
  agentId: string
}
```

返回：

- 若 child 已结束，返回 `AgentRunResult`
- 若仍在运行，返回 `status='running'`

### `send_agent`

V1 不实现，但语义必须预留：

- 向已有 child 发送追加指令
- 主要服务 running background worker
- 用于“继续当前 child”，不是重新 spawn 新 child

### `stop_agent`

V1 不实现，但语义必须预留：

- 请求 child 停止继续执行
- 主要用于需求变更、方向错误或用户取消

## Background Wait Semantics

`wait_agent` 不能被设计成无界忙轮询，否则 parent transcript 会被无意义的 tool call / tool result 撑大。

### Core Rule

`wait_agent` 不是 heartbeat tool，而是**阶段性同步点**。

### V1 Behavior

1. `wait_agent` 在 child 仍运行时返回 `status='running'`
2. 返回结果必须包含建议的最短重试间隔，例如：

```ts
{
  agentId: string
  status: 'running'
  suggestedRetryAfterSeconds: number
}
```

3. parent 系统提示必须明确：
   - 不要紧密轮询
   - 只有在确实需要 child 结果时才调用 `wait_agent`

### Default Retry Guidance

V1 建议：

- 默认 `suggestedRetryAfterSeconds = 15`
- 同一 child 在无新结果时，连续 `wait_agent` 超过 `3` 次应触发 parent 提醒：停止轮询，继续其他工作

### Transcript Impact

`wait_agent` 轮询记录会进入 parent transcript，但应被视为：

- 低价值 runtime bookkeeping
- 在 compact 时优先进入可压缩区

V1 不要求特殊 transcript 类型，但 compact policy 应优先压缩这些重复的 wait records，而不是保留在 hot path 中。

### Deferred Tools

`send_agent` 和 `stop_agent` 不在 V1 实现，但必须在 runtime 内部 schema 上预留。

原因：

- free-code 已证明 continue / stop 对 worker 很有价值
- 如果不预留 agent identity 和 state machine，后续补上会很别扭

## Foreground Progress Visibility

foreground child 不能成为黑盒长阻塞。

### Core Rule

即使 `spawn_agent` 在 foreground 阻塞，runtime 也必须预留进度事件通道。

### Minimal V1 contract

V1 不要求完整子线程 UI，但 orchestration layer 必须支持类似：

```ts
onChildProgress?: (event: {
  agentId: string
  role: 'explorer' | 'worker' | 'verifier'
  summary: string
}) => void
```

这允许：

- explorer 跑 30 秒时，用户仍能看到阶段性更新
- foreground worker / verifier 不至于完全静默

## Runtime State Model

### Parent-Side Tracking

parent runtime 必须维护最小 agent registry：

```ts
interface ChildAgentRecord {
  agentId: string
  parentSessionId: string
  parentDepth: number
  childDepth: number
  role: 'explorer' | 'worker' | 'verifier'
  execution: 'foreground' | 'background'
  status: 'running' | 'completed' | 'failed' | 'stopped'
  childSessionId: string
  transcriptPath: string
  timeoutMs: number
  startedAt: string
  finishedAt?: string
}
```

## Child State Machine

V1 必须定义 child lifecycle 的合法状态转换。

### States

- `running`
- `completed`
- `failed`
- `stopped`

### Allowed transitions

```text
running -> completed
running -> failed
running -> stopped
```

### Disallowed transitions in V1

- `completed -> running`
- `failed -> running`
- `stopped -> running`
- 任意 terminal -> 其他 terminal

也就是说，V1 child 是一次性执行单元。

### Implications

- `failed` child 不支持原地 retry
- `stopped` child 不支持原地 resume
- 如果 parent 需要重试，应重新 `spawn_agent`

这和 V1 不实现 `send_agent` / `stop_agent` 的继续语义保持一致。

## Depth Semantics

`maxDepth` 必须按**嵌套层数**定义，而不是生命周期内累计 spawn 次数。

### Definition

- root parent session 的 depth = `0`
- parent 直接 spawn 的 child depth = `1`
- child 再 spawn 的 grandchild depth = `2`

### V1 rule

`maxDepth = 1` 的含义是：

- root parent 可以 spawn direct child
- direct child 不能继续 spawn child

### Important clarification

depth **不是累计 spawn 次数**。

所以：

- parent 先 spawn A，A 完成
- 再 spawn B

这仍然是合法的，两次 child 都是 depth `1`。

### Persistence

这个 registry 不能只存在内存里。

V1 必须把 child registry 持久化到 parent session scope 的磁盘状态中，否则：

- parent session 崩溃后无法找回 background worker
- `wait_agent` 无法 resume
- session resume 会丢掉 child linkage

### V1 storage rule

建议在 parent session 目录下持久化独立 sidecar，例如：

```text
<session-dir>/
  transcript.jsonl
  usage.jsonl
  child-agents.jsonl
```

其中 `child-agents.jsonl` 记录 child lifecycle events：

- spawned
- completed
- failed
- stopped

resume 时：

- parent runtime 必须先恢复 child registry
- 再允许 `wait_agent`

也就是说，`wait_agent` 的 source of truth 不是内存任务表，而是：

1. 恢复后的 child registry
2. child session transcript / terminal record

## Failure And Crash Semantics

child 运行中的异常路径必须从第一天定义清楚。

### Child status transitions

允许的终态：

- `completed`
- `failed`
- `stopped`

其中：

- runtime 异常
- provider error 未恢复
- child process / execution failure

都统一归到 `failed`。

timeout 也统一归到 `failed`，但 error reason 必须明确标记为 timeout。

### Who writes child status

child runtime 自己负责写 terminal status；
如果 child runtime 崩溃到无法正常收尾，则 parent-side orchestration layer 必须负责把 child record 标成 `failed`。

### Transcript retention

无论成功还是失败：

- child transcript 都必须保留
- child transcript path 必须仍然可读

失败 transcript 对调试、resume 设计和后续 verifier 诊断都很重要。

### `wait_agent` on failed child

如果 child 已失败，`wait_agent` 返回：

```ts
{
  agentId: string
  role: 'explorer' | 'worker' | 'verifier'
  status: 'failed'
  summary: string
  finalText?: string
  transcriptPath: string
  error?: string
}
```

### Foreground failure behavior

foreground child 失败时：

- `spawn_agent` 不应抛 transport-level tool error
- 应返回一个 `status='failed'` 的结构化结果

原因：

- child failure 是 task outcome，不是 runtime tool invocation malformed
- parent agent 需要读取失败结果并决定是重试、改写任务，还是报告给用户

只有在 `spawn_agent` 自身无法创建 child session、schema 非法、runtime primitive 初始化失败时，才应作为真正的 tool error 抛回。

## `wait_agent` Semantics After Foreground Completion

foreground `spawn_agent` 完成后，child 依然是一个有 session 和 transcript 的已结束 task。

因此，如果模型之后错误地再调用：

```text
wait_agent(agentId)
```

V1 行为应是：

- 返回该 child 已缓存的 terminal result
- 不报错

原因：

- child 记录和 transcript 仍然存在
- 这比“报错说你不该等它”更利于 parent 恢复和实现一致性

只有在：

- `agentId` 不存在
- child registry 中找不到该 child

时，`wait_agent` 才应返回真正的 lookup error 或 structured not-found result。

## Verifier Verdict Semantics

`verification.verdict` 不能只是标签，必须有明确 orchestration 语义。

### `pass`

- verifier 找到了足够证据支持当前 claim
- parent 可以把验证视为通过

### `fail`

- verifier 找到了明确反例、错误、缺失验证或失败命令
- parent 不应报告任务完成

### `partial`

- verifier 完成了部分验证
- 有些关键项通过，但仍存在未覆盖、无法执行或证据不足的部分

对 parent 的默认语义：

- `partial` **不算通过**
- parent 不应把它当作 final success gate
- parent 可以：
  - 继续修复 / 补验证
  - 或向用户明确报告“部分验证完成，但仍有未验证项”

### `not_applicable`

- 当前任务不需要 verifier verdict
- 只用于没有验证语义的角色或不适用场景

### Child-Side Runtime

child 本质上是一个新的 `QueryEngine` + session + sink 实例。

但它不是普通用户 session。

它需要：

- child role contract
- child briefing items
- parent-child metadata linkage
- optional background scheduling

## Transcript And Session Model

每个 child 必须有独立 session transcript。

### Required invariants

1. child transcript 不直接混入 parent transcript
2. parent transcript 只记录：
   - `spawn_agent` tool call
   - `spawn_agent` tool result
   - `wait_agent` tool result
3. child transcript path 必须可恢复
4. child session metadata 必须记录 parent linkage

### Why this matters

如果把 child 中间 transcript 直接灌回 parent：

- 会污染主上下文
- 会破坏 prompt cache
- 会让 compact 和 resume 变复杂
- 会失去 subagent 作为独立 context boundary 的价值

## Approvals And Sandbox

默认策略与 Codex 保持一致：

- child 继承 parent 的 sandbox / approval policy
- 角色可以做更严格的默认限制，但不能更宽松

### Background approval behavior

background worker 下，不能假设用户随时在场批准危险操作。

V1 规则：

- 如果 background child 触发新的 approval request
- 且当前运行环境无法立刻向用户展示并获取批准

则：

- 该操作默认拒绝
- child 收到一个明确的 approval-denied / approval-unavailable 错误
- child 可以继续处理这个错误，或最终以 `failed` 结束

V1 不做“后台挂起等待人工批准”的复杂交互。

### Role defaults

- `explorer`: read-only equivalent behavior
- `verifier`: read-only equivalent behavior
- `worker`: inherit parent write capability

## Read-Only Enforcement

`explorer` 和 `verifier` 的 read-only 不是 prompt convention，而是 runtime-enforced policy。

prompt 里的角色说明只是辅助约束。
真正的执行约束必须来自 runtime。

### Enforcement Rule

当 role 是 `explorer` 或 `verifier` 时，runtime 必须在 child registry / permission layer 上屏蔽写入能力。

至少要禁止：

- file write / edit / create / delete / move / copy
- destructive shell commands
- commit / branch mutation 类 git 操作

### Implementation Shape

V1 不强制具体实现细节，但行为必须等价于：

1. child 可见工具集已去除写工具
2. shell / permission 层再做一次 deny

也就是说：

- 第一层：tool surface 收窄
- 第二层：permission enforcement 兜底

仅靠 briefing 写“不要改文件”不能视为满足 spec。

## Role Tool Surface

subagent 的角色边界必须映射到具体工具层，而不是只停留在行为描述。

### Core Rule

每个 child role 在运行时看到的是 role-filtered tool subset，不是 parent 的全量工具集。

### `explorer` tool surface

允许：

- 只读文件工具
- 搜索 / glob / grep / list_dir / stat_path
- git read 工具（如 status / diff / log）
- LSP 只读能力
- 非破坏性 shell / script 执行，用于 inspection

禁止：

- 所有写文件工具
- destructive shell
- git mutation
- config mutation

### `worker` tool surface

允许：

- parent 允许范围内的全部 coding tools
- 文件读写
- 搜索
- LSP
- shell / script
- git read

禁止：

- 超出 parent approval / sandbox 的能力

### `verifier` tool surface

允许：

- explorer 的全部只读工具
- 非破坏性测试 / 验证命令

禁止：

- 文件写入
- destructive shell
- git mutation

### Shell nuance

`explorer` 和 `verifier` 可以使用 shell，但仅限 non-destructive commands。

也就是说：

- shell 不是一刀切禁用
- 但必须经过 runtime 的 destructive-command guard

## Role × Tool Matrix

为了避免实现时各自理解，V1 直接按 Merlion 当前 builtin tool 名称定义 allowlist。

### `explorer`

#### Allow

- `read_file`
- `list_dir`
- `stat_path`
- `search`
- `grep`
- `glob`
- `git_status`
- `git_diff`
- `git_log`
- `fetch`
- `lsp`
- `tool_search`

#### Conditional

- `bash`
- `run_script`

条件：

- 只允许 non-destructive inspection / verification commands
- 继续受 runtime destructive-command guard 和 parent approval policy 约束

#### Deny

- `write_file`
- `append_file`
- `create_file`
- `edit_file`
- `copy_file`
- `move_file`
- `delete_file`
- `mkdir`
- `todo_write`
- `config`
- `config_set`
- `config_get`
- `ask_user_question`
- `sleep`

### `worker`

#### Allow

- `read_file`
- `list_dir`
- `stat_path`
- `search`
- `grep`
- `glob`
- `write_file`
- `append_file`
- `create_file`
- `edit_file`
- `copy_file`
- `move_file`
- `delete_file`
- `mkdir`
- `bash`
- `run_script`
- `list_scripts`
- `git_status`
- `git_diff`
- `git_log`
- `fetch`
- `lsp`
- `tool_search`
- `todo_write`

#### Conditional

- `config`
- `config_get`
- `config_set`
- `ask_user_question`
- `sleep`

条件：

- 仍受 parent approval / sandbox / interaction policy 约束
- `ask_user_question` 仅在 parent runtime 明确允许 child 交互时才开放；V1 默认建议关闭

### `verifier`

#### Allow

- `read_file`
- `list_dir`
- `stat_path`
- `search`
- `grep`
- `glob`
- `git_status`
- `git_diff`
- `git_log`
- `fetch`
- `lsp`
- `tool_search`
- `list_scripts`

#### Conditional

- `bash`
- `run_script`

条件：

- 只允许 non-destructive test / verification commands
- 继续受 runtime destructive-command guard 和 parent approval policy 约束

#### Deny

- `write_file`
- `append_file`
- `create_file`
- `edit_file`
- `copy_file`
- `move_file`
- `delete_file`
- `mkdir`
- `todo_write`
- `config`
- `config_set`
- `config_get`
- `ask_user_question`
- `sleep`

### Notes

1. 这张矩阵是 V1 runtime 默认值，不代表后续 custom agents 的最终形态。
2. `config_get` 在 `explorer` / `verifier` 中也默认关闭，是为了保持角色最小化，而不是因为读取配置本身有危险。
3. `ask_user_question` 在 child 中默认关闭，是为了避免多线程交互复杂度提前进入 V1。

## Concurrency And Depth Limits

V1 必须从第一天限制 fan-out。

### Proposed defaults

- `maxDepth = 1`
- `maxConcurrentChildren = 3`

### Why

一旦允许递归 spawn 或过高并发：

- token 成本会失控
- 本地资源会被打满
- 调试会非常困难

Merlion 应该先做“少量、高价值 delegation”，不是“自动化分叉树”。

## Interrupt Semantics

CLI 下必须定义用户中断行为。

### Foreground child + Ctrl+C

当用户在 foreground child 运行时按下 Ctrl+C：

- child 收到 stop request
- child transcript 保留到中断点
- child terminal status 记为 `stopped`
- parent `spawn_agent` 返回结构化 `status='stopped'` 结果

parent loop 不应因此损坏；它应恢复到可继续状态。

### Background child + user interrupt

用户中断 parent 当前 turn 时：

- 不应自动 kill background child
- background child 继续按其生命周期运行

除非后续显式调用 `stop_agent`。

## Parent Prompting Contract

主 agent 需要明确的系统提示规则，至少包括：

1. 只有在任务明显可分解、或 child context 边界能显著减少主上下文污染时才 spawn
2. 不要把当前自己正在做的关键阻塞任务无脑扔给 child
3. `explorer` 用于证据收集，不用于改文件
4. `worker` 用于 bounded implementation
5. `verifier` 用于独立验证，不用于实现
6. foreground 适合立即依赖结果的任务
7. background 主要用于较长的 worker 任务

### Draft parent prompt block

下面这段是 V1 可直接转成系统提示的草案：

```text
You can delegate bounded subtasks to subagents, but delegation is expensive and should be used deliberately.

Use `explorer` for read-heavy codebase investigation. Use it to gather evidence, locate files, trace execution paths, and find tests. Do not use `explorer` for file changes.

Use `worker` for bounded implementation tasks. Give it a specific task and, when relevant, a write scope. Prefer `worker` when a task is substantial enough to benefit from a separate context.

Use `verifier` for independent validation. A verifier does not implement fixes. It checks whether a change actually holds up, and its verdict should be treated as a gate.

Prefer foreground subagents when your next step depends on the result immediately. Prefer background `worker` subagents only for longer implementation tasks that do not need immediate follow-up.

Do not spawn subagents casually. If the task is small enough to do directly, do it directly. If you delegate research, do not duplicate the same work yourself while the child is running.

Subagents are separate runtimes with their own transcripts. They do not exist to dump more raw output into your context. Use them when a clean context boundary helps.
```

这不是最终措辞，但它把 Parent Prompting Contract 从“原则列表”变成了可注入文本。

## End-to-End Happy Path

下面是一条 V1 设计应支持的完整 happy path。

### Scenario

用户说：

> The login flow is flaky. Find the affected tests, add coverage if missing, and verify the fix.

### Step 1: parent spawns explorer

parent 调用：

```json
{
  "role": "explorer",
  "task": "Find the tests and code paths related to the login flow flake. Report the likely owning files and missing test coverage.",
  "execution": "foreground",
  "purpose": "This will be used to plan a targeted fix and test update."
}
```

runtime：

- 生成 explorer role system prompt
- 从当前 session state 生成 briefing
- 创建 child session
- 运行 explorer

parent 拿到：

- `status='completed'`
- `summary`
- `finalText`
- `filesRead`
- `transcriptPath`

### Step 2: parent spawns worker

parent 根据 explorer 结果，调用：

```json
{
  "role": "worker",
  "task": "Update the affected login tests and fix the flaky path in the login handler.",
  "execution": "foreground",
  "purpose": "Implement the fix and add missing coverage.",
  "writeScope": ["src/auth/**", "tests/auth/**"]
}
```

worker 完成后返回：

- `status='completed'`
- `summary`
- `finalText`
- `filesChanged`
- `commandsRun`

### Step 3: parent spawns verifier

parent 再调用：

```json
{
  "role": "verifier",
  "task": "Verify that the login flake fix and new coverage are valid. Re-run the relevant tests independently.",
  "execution": "foreground",
  "purpose": "Independent verification before reporting success."
}
```

runtime 自动把 worker 的 `filesChanged` 放入 verifier briefing 的 `verificationTarget.changedFiles`。

verifier 返回：

- `status='completed'`
- `verification.verdict='pass' | 'fail' | 'partial'`
- `summary`
- `finalText`

### Expected parent behavior

- `pass`：可报告完成
- `fail`：不报告完成，继续修复或重试
- `partial`：不算通过，必须继续补验证或明确向用户说明未验证项

## Child Session Compaction

child 是独立 session，因此必须拥有与 parent 一样的 compact 能力。

### Core Rule

每个 child `QueryEngine` 都应启用自身的 compact 机制。

### Why

- 长时间 `worker` 可能运行很多轮
- 如果 child 不 compact，它会先于 parent 撑爆上下文

### Compaction scope

child compact 只影响 child transcript 的运行时表示，不影响 parent transcript。

也就是说：

- parent 默认只拿 structured result
- child transcript 可以在自己的 session 内 compact
- parent 不依赖 child 的原始全量 transcript 才能 orchestration

### Reading compacted child transcripts

如果 parent 或用户后续查看 child transcript：

- 读到的是 compact 后的 child session
- 这是可接受的

因为 child transcript 的职责是：

- 调试
- 审计
- 人工复盘

而不是作为 parent 主上下文的 source of truth。

## Implementation Phasing

### Phase 1

实现：

- role taxonomy
- child session model
- `spawn_agent`
- `wait_agent`
- runtime-fixed `briefed + same_dir`
- foreground for all three roles
- background only for `worker`
- verifier hard verdict contract
- child registry persistence
- runtime-enforced read-only for `explorer` / `verifier`

### Phase 2

实现：

- `send_agent`
- `stop_agent`
- richer verifier UX / evidence formatting

### Phase 3

实现：

- `worktree` isolation for `worker`
- better parent/child UI
- custom agent definitions

## Acceptance Criteria

1. 调用 `spawn_agent(role="explorer", execution="foreground", task=...)` 时，runtime 成功创建 child session，并返回包含 `agentId`、`summary`、`transcriptPath` 的结构化结果。
2. child transcript 文件必须存在于返回的 `transcriptPath`，且 parent transcript 只包含 `spawn_agent` / `wait_agent` 的 tool call 和 tool result，不包含 child 的中间推理步骤。
3. `explorer` 和 `verifier` child 在 runtime 层无法调用写工具；即使模型尝试写入，也会被工具面收窄或 permission 层拒绝。
4. `worker` 支持 `foreground` 和 `background`；`explorer` 与 `verifier` 在 V1 调用 `background` 时必须返回 schema-level 或 structured rejection，而不是静默接受。
5. `spawn_agent` 超过 `maxConcurrentChildren` 时必须返回 `status='rejected'` 和 `reason='capacity_limit_exceeded'`，不会隐式排队。
6. background child 运行时，`wait_agent` 返回 `status='running'` 时必须包含 `suggestedRetryAfterSeconds`。
7. child 超时或崩溃后，child record 状态必须转为 `failed`，child transcript 仍然保留，`wait_agent` 或 foreground `spawn_agent` 返回的结构化结果中必须包含非空 `summary`。
8. `summary` 由 runtime 生成，`finalText` 来自 child 最后一条 assistant 文本；两者在返回结构上同时可见且语义不同。
9. session resume 后，parent runtime 能从持久化 child registry 恢复 background child linkage，并继续执行 `wait_agent`。
10. V1 对模型暴露的 `spawn_agent` input 不包含 `contextMode` 或 `isolation`；运行时固定使用 `briefed + same_dir`。

## Implementation Notes

当前实现已经落地：

- built-in tools:
  - `spawn_agent`
  - `wait_agent`
- roles:
  - `explorer`
  - `worker`
  - `verifier`
- runtime-fixed defaults:
  - `briefed`
  - `same_dir`
- execution:
  - `foreground` for all three roles
  - `background` for `worker`
- persistence:
  - child registry sidecar under parent session scope
  - child transcript kept in its own session

当前验证覆盖：

- unit coverage for:
  - foreground explorer
  - read-only enforcement
  - background worker lifecycle and `wait_agent`
- local e2e coverage for:
  - parent loop spawning and waiting for a background worker
- live-model e2e coverage for:
  - `explorer` foreground delegation
  - `verifier` foreground delegation

目前还没有用 live-model e2e 把 `background worker` 作为稳定回归门；这条路径当前由 local e2e 覆盖。

## Sources

- OpenAI Codex Subagents: <https://developers.openai.com/codex/subagents>
- free-code `Task.ts`: <https://github.com/paoloanzn/free-code/blob/main/src/Task.ts>
- free-code `coordinatorMode.ts`: <https://github.com/paoloanzn/free-code/blob/main/src/coordinator/coordinatorMode.ts>
- free-code `LocalAgentTask.tsx`: <https://github.com/paoloanzn/free-code/blob/main/src/tasks/LocalAgentTask/LocalAgentTask.tsx>
- free-code `sessionStorage.ts`: <https://github.com/paoloanzn/free-code/blob/main/src/utils/sessionStorage.ts>
- free-code `prompts.ts`: <https://github.com/paoloanzn/free-code/blob/main/src/constants/prompts.ts>
