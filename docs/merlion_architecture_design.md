# Merlion Architecture Design

Status: `implementation-level architecture document`  
Last Updated: `2026-04-18`

## Purpose

这份文档不是愿景说明，也不是 README 的展开版。它的目标更直接：

- 基于当前代码，讲清楚 Merlion 这个 runtime 实际上是怎么工作的
- 把几条最重要的设计主线拆开说明：
  - 上下文管理
  - ReAct agent loop
  - 会话状态与“记忆”
  - 工具编排
  - verification 闭环
- 给后续的教学写作、架构重构、功能评审提供一个统一的实现视图

本文只描述当前仓库真实存在的结构，不预设未来会做什么。

## 1. 总体定位

Merlion 是一个本地运行的 CLI coding agent runtime。它不是一个“大而全”的 agent 平台，也不是一个复杂的多 agent 编排系统。它的核心目标，是把一个单 agent coding runtime 控制在仍然可以通读和解释的范围内。

从实现上看，它是一个偏“窄”的系统：

- 入口很薄
- provider 层很薄
- runtime 以单个 conversation 为中心
- 工具面实用但收敛
- context 主要围绕代码仓库本身构建
- verification 是显式流程，而不是隐含在某个黑盒调度器里

所以它更像一个完整、可运行、但有意保持小范围的 reference implementation。

## 2. 高层结构

Merlion 当前可以分成 7 个主要层次：

1. `src/index.ts`
   负责 CLI 启动、参数解析、配置解析，以及把控制权交给 CLI runtime 或 WeChat transport。

2. `src/runtime/runner.ts`
   负责 CLI 模式下的 wiring：provider、tool registry、context service、session、query engine、sink、verification。

3. `src/runtime/query_engine.ts`
   conversation-scoped runtime。它持有消息历史、runtime state、tracked permission state，并负责一次请求从初始化到提交再到后处理的整个生命周期。

4. `src/runtime/loop.ts`
   单次请求的主 agent loop。它负责把消息发给模型，处理 tool calls，把工具结果回填回消息历史，并注入各种纠偏和收敛提示。

5. `src/runtime/executor.ts` + `src/tools/*`
   工具注册、工具描述、参数校验、分批执行、并发控制、结果回传。

6. `src/context/*` + `src/artifacts/*`
   上下文系统。包括 system prompt、orientation、path guidance，以及 `.merlion/*` 下的代码库索引和进度 artifact。

7. `src/verification/*`
   验证系统。负责发现可运行的检查项、执行检查、必要时触发 fix rounds。

可以把它看成一条比较直的链路：

```text
CLI / WeChat input
  -> runner / transport wiring
  -> QueryEngine
  -> runLoop()
  -> provider.complete(...)
  -> tool execution
  -> context / artifact updates
  -> final summary
  -> optional verification rounds
```

## 3. 启动与请求生命周期

### 3.1 入口

主入口在 `src/index.ts`。

它做的事情很少：

- 解析 CLI flags
- 处理 `--help` / `--version`
- 调用 `resolveCliConfig()` 加载 provider / model / key / baseURL
- 根据模式分流：
  - 普通 CLI 模式走 `runCliRuntime()`
  - WeChat 模式走 `launchWeixinSinkMode()`

入口本身不持有任何业务状态，也不做复杂编排。这样做的好处是，应用启动逻辑和 runtime 逻辑是分开的。

### 3.2 CLI runtime wiring

`src/runtime/runner.ts` 是 CLI 模式的总装层。

它负责创建这些对象：

- `OpenAICompatProvider`
- builtin `ToolRegistry`
- `PermissionStore`
- session transcript / usage files
- `ContextService`
- `QueryEngine`
- CLI sink
- prompt observability tracker

这一层的职责不是执行 agent 行为，而是把各个部件接起来，并决定请求从哪里进入 runtime。

在 CLI 模式里，真正进入 agent 之前还有一层很轻的输入分发：

- 普通 prompt 进入 `QueryEngine.submitPrompt()`
- slash command 走本地命令分支
- shell shortcut 直接走 `bash` tool
- verification round 由 runner 在任务结束后显式触发

这个分发层现在被收敛在 `executeLocalTurn()` 这样的薄函数里，没有再保留一层额外 task registry。

### 3.3 QueryEngine 的位置

`QueryEngine` 是整个架构的中心对象。

它的职责不是“再做一个 loop”，而是把 loop 外围那些跨回合、跨请求需要维护的事情收进来：

- 持有消息历史 `history`
- 持有 runtime state
- 做一次性的 initialize
- 在提交 prompt 前拼装 prelude
- 在 loop 结束后更新 artifact 和 runtime state

如果只看概念，`runLoop()` 更像“单次执行器”，而 `QueryEngine` 才是 conversation runtime。

它在 loop 结束后的后处理尤其关键，会统一做这些事：

- 基于工具调用和 git 信号收集 changed paths
- 更新 `.merlion/codebase_index.md`
- 更新 `.merlion/progress.md`
- 检查 guidance 是否可能已经过时
- 如果当前仓库在 generated-map mode 下，还会按需刷新 `.merlion/maps/*`
- 把最终 summary 和 compact 状态写回 runtime state

## 4. 上下文系统

Merlion 的上下文不是单一来源，而是由几层东西叠起来的。

### 4.1 System prompt

system prompt 由 `src/prompt/system_prompt.ts` 生成。

它由两部分组成：

- 固定规则
  - 用工具完成任务
  - 先做 path-guided exploration，再做 broad search
  - bug-fix 时 source-first
  - 完成前尽量做强 verification
- 动态 section
  - workspace scope
  - tool call contract
  - workspace hygiene

动态 section 通过 `src/prompt/sections.ts` 做 session 级缓存，避免同一个 session 里重复解析同样的 prompt section。

### 4.2 Orientation bootstrap

在 `ContextService.prefetchIfSafe()` 里，Merlion 会在信任级别允许的情况下预取一份“启动时上下文”。

这一层主要由 `src/context/orientation.ts` 负责组装，来源包括：

- `AGENTS.md` / `MERLION.md`
- `.merlion/progress.md`
- `.merlion/codebase_index.md`

它不是把整个仓库塞给模型，而是做一个有预算的摘要拼装：

- `agentsTokens`
- `progressTokens`
- `indexTokens`
- `totalTokens`

预算可以按环境变量覆盖，也会基于仓库文件数给出默认值。

这一层的目标不是“给模型全部信息”，而是让模型一开始就有一份足够像地图的高层视图。

### 4.3 Path guidance

这是 Merlion 上下文设计里最有特色的一层。

它的核心思想是：

- 不要一上来就做 repo-wide broad search
- 先从用户 prompt 或工具输出里提取路径信号
- 再把和这些路径最相关的 `AGENTS.md` / `MERLION.md` scope 增量注入

实现位置：

- `src/context/path_guidance.ts`
- `src/context/service.ts`

它分两种触发：

1. Prompt-derived guidance
   用户 prompt 里如果直接提到了路径，`buildPromptPrelude()` 会先给模型一条 system message，明确这些路径是第一优先级，然后再按这些路径加载 guidance delta。

2. Tool-event-derived guidance
   每次 tool batch 结束后，`QueryEngine` 会从 tool arguments 和 tool output 里提取候选路径，交给 `buildPathGuidanceMessages()`，按需注入新的 guidance message。

这里有两个重要约束：

- guidance 是增量的，不会重复加载已经读过的 guidance 文件
- guidance 有严格 token budget，不会无限增长

这使得 Merlion 的 context 不是“启动一次灌满”，而是跟着 agent 的探索路径逐步变细。

### 4.4 Reactive compact

Merlion 还有一层非常轻量的上下文压缩机制。

`src/context/compact.ts` 采用的是最简单的一种策略：

- 保留首个 system message
- 保留最近 N 条消息
- 把中间历史压成一条 summary-style system message

这个 compact 不是额外调用模型来做摘要，而是本地字符串摘要。它的优点是：

- 实现简单
- 成本很低
- 足够防止消息历史无限膨胀

代价也很明确：

- 摘要质量有限
- 它更像工程保险丝，而不是高质量 memory compression

### 4.5 ContextService 的角色

`ContextService` 是上下文层的总入口。

它统一负责：

- `getSystemPrompt()`
- `prefetchIfSafe()`
- `buildPromptPrelude()`
- `buildPathGuidanceMessages()`
- `extractCandidatePathsFromText()`
- `extractCandidatePathsFromToolEvent()`

这意味着，对 `QueryEngine` 来说，它不需要知道 orientation、path guidance、artifact 这些细节，它只需要向 `ContextService` 要上下文。

## 5. ReAct agent loop

### 5.1 基本结构

主循环在 `src/runtime/loop.ts`。

它依然是一个标准的 ReAct-style loop：

1. 取当前 `state.messages`
2. 发给模型 `provider.complete(messages, tools)`
3. 如果模型返回 tool calls：
   - 执行工具
   - 把 `role: tool` 消息加回历史
   - 继续下一轮
4. 如果模型直接返回文本：
   - 进入收尾逻辑
   - 视情况结束，或注入 recovery/nudge 再跑一轮

状态本身很轻：

- `messages`
- `turnCount`
- `maxOutputTokensRecoveryCount`
- `hasAttemptedReactiveCompact`
- `nudgeCount`

所以它不是一个复杂 planner，也不是一个显式 task graph。它仍然是单 agent、同步、消息驱动的 loop。

### 5.2 它为什么不只是“裸 ReAct”

Merlion 的 loop 虽然基本形态是 ReAct，但它并不是无保护的“模型说什么就做什么”。

它外面包了一层比较厚的 guardrails。这些 guardrails 现在被抽到 `src/runtime/loop_guardrails.ts`，主 loop 只负责调用。

这些 guardrails 的作用主要有几类：

- 工具参数错误纠偏
- 重复错误工具调用纠偏
- 连续无进展 batch 纠偏
- 连续无 mutation 纠偏
- exploration 过度纠偏
- todo drift 纠偏
- 大 diff 提醒
- edit 后被 write_file 覆盖提醒
- mutation oscillation 提醒
- bug-fix 场景下 test-first 漂移提醒
- verification 不足提醒

也就是说，Merlion 的 loop 不是“planner + executor”双系统，而是“ReAct 主循环 + runtime-injected control hints”。

这是一种很务实的做法：

- 不需要单独实现 planner
- 但也不完全把收敛性交给模型自己处理

### 5.3 Tool-call turn

当模型返回 `finish_reason === 'tool_calls'` 时，loop 会进入工具执行分支。

这个分支做几件事：

1. 调用 `executeToolCalls()`
2. 收集每个 tool result event
3. 把 tool messages 追加回 `state.messages`
4. 基于 tool batch 结果更新若干收敛信号：
   - 是否全失败
   - 是否有 mutation
   - mutation 是不是只打到 test 文件
   - 是否在反复 exploration
   - 是否在只写 todo
   - 是否触发 oscillation / large diff / overwrite 等模式
5. 按需注入 user-role correction messages
6. 调用 `onToolBatchComplete()`

这里有一个重要设计：很多纠偏提示都被伪装成新的 `user` message 再塞回消息历史。

这意味着 runtime 不直接“替模型决策”，而是通过用户级强提示把下一轮决策边界收窄。

### 5.4 Stop turn 与 recovery

模型返回 `stop` 并不一定就代表本轮完成。

Merlion 会根据上下文做额外判断：

- 如果刚执行完工具却返回空文本，会要求模型补一个自然语言总结
- 如果发生过多轮错误但还没有任何成功 mutation，会要求模型不要现在结束
- 如果已经有代码改动，但没有做任何 verification，也会注入 verification hint
- 如果模型只是“说要做”但没有 tool call，则会触发 nudge

这部分逻辑让最终输出更稳定，也让“看起来结束了，其实没真正完成”的情况少很多。

## 6. 工具编排

### 6.1 Tool registry 与 tool pool

Merlion 的工具系统是统一注册的。

关键部件：

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/pool.ts`
- `src/tools/catalog.ts`
- `src/tools/builtin/*`

`ToolDefinition` 里除了常规的 `name / description / parameters / execute`，还有一些偏 runtime 的元数据：

- `concurrencySafe`
- `isReadOnly`
- `isDestructive`
- `requiresUserInteraction`
- `requiresTrustedWorkspace`
- `modelGuidance`
- `modelExamples`
- `guidancePriority`

这说明工具定义不只是执行面接口，也是模型提示面和安全面接口。

### 6.2 提供给模型的工具 schema

provider 层在 `src/providers/openai.ts`。

它做的不是简单把工具名和参数原样发给模型，而是通过 `buildModelToolDescription()` 重新组织工具描述：

- 基础 description
- model guidance
- examples
- critical / normal priority

这样模型看到的工具 schema，比单纯的 JSON schema 更强一点，能把“应该怎么用”也带进去。

### 6.3 工具执行器

`src/runtime/executor.ts` 负责真正执行工具调用。

它做四件关键的事：

1. 严格 JSON 参数校验
   - tool args 必须是 strict JSON object
   - required 字段必须存在
   - path-like 参数必须是非空、合理的路径

2. 工具批处理
   - 先按 `concurrencySafe` 切 batch
   - 可并发的工具一起跑
   - 不可并发的工具单独跑

3. 结果预算控制
   - 对工具输出做 budget 截断
   - 避免某个工具返回过长文本把上下文塞满

4. 统一回填为 `role: tool` 消息
   - 无论是成功还是失败，最终都会回到消息历史

这保证了工具执行是模型 loop 的一部分，而不是跑在侧面的一套不可见子系统。

### 6.4 权限

权限控制由 `src/permissions/store.ts` 提供。

模式有三种：

- `interactive`
- `auto_allow`
- `auto_deny`

同时，`QueryEngine` 会用 `createTrackingPermissionStore()` 包一层，把权限决策写进 runtime state：

- 被拒过哪些工具
- 哪些工具被 session-level allow 过
- 上一次决策是什么

权限因此有两层含义：

- 行为控制
- 可观察的会话状态

## 7. 会话状态与“记忆”

Merlion 这里的“记忆”不是一个单独模块，而是几层状态和 artifact 叠出来的。

### 7.1 消息历史

最直接的一层 memory 是消息历史。

它保存在 `QueryEngine.history` 和 `LoopState.messages` 里。所有上下文、tool output、recovery hint，最终都变成消息历史的一部分。

这是 agent 最原生的一层短期记忆。

### 7.2 Session transcript

`src/runtime/session.ts` 负责把消息和 usage 持久化为 JSONL。

它做这些事：

- 为每个 session 分配 ID
- 把 transcript 放在项目内 `.merlion/sessions` 下
- 记录 usage
- 支持 resume
- 对 transcript 做简单的 secret redaction

所以 Merlion 的 session persistence 不是数据库，也不是远端服务，而是 repo-local 或 project-local 的文件持久化。

### 7.3 Runtime state

`src/runtime/state/types.ts` 定义了 `RuntimeState`，目前包含四块：

- `permissions`
- `compact`
- `skills`
- `memory`

这里要实话实说：

- `permissions` 和 `compact` 现在已经在用
- `skills` 和 `memory` 目前更像预留的结构化 state slice，还没有真正成为主流程的一部分

也就是说，Merlion 现在已经有 runtime state 的“骨架”，但不是每一块都已经长成完整功能。

### 7.4 Repo-local artifacts

Merlion 更重要的一层“长期记忆”，其实在 `.merlion/*` 这些 artifact 上。

主要有三类：

1. `AGENTS.md` / `MERLION.md` guidance
   这是人为维护或自动生成的局部指导信息。

2. `.merlion/codebase_index.md`
   这是代码库地图，帮助模型快速知道仓库里主要有什么。

3. `.merlion/progress.md`
   这是进度记录，记录最近做了哪些变更或提交。

这些东西不是“向量记忆”，也不是 embedding retrieval。它们是显式的、repo-local 的文本 artifact。

这是 Merlion 的一个重要取向：把很多 memory 问题先变成可读、可维护的 artifact 问题。

## 8. Artifact 与上下文维护

### 8.1 Codebase index

`src/artifacts/codebase_index.ts` 负责维护代码库索引。

它会总结：

- top-level 目录结构
- package scripts
- 重要文件映射
- 最近变更文件
- guidance scopes

这个 index 不是精确语义索引，而是一份高性价比的仓库导航图。

### 8.2 Progress artifact

`src/artifacts/progress_auto.ts` 会基于 runtime signals 自动更新 `.merlion/progress.md`。

触发信号包括：

- 是否有成功 commit
- 本轮改了哪些路径

它的作用很朴素：把最近做过的事用一份文本显式记下来，让后续上下文可以利用。

### 8.3 Generated maps

当仓库里没有足够的 `AGENTS.md` / `MERLION.md` 时，Merlion 可以生成 fallback maps。

这些 maps 不直接替代人工 guidance，但能给一个没有任何局部说明的仓库补一份最基本的可导航结构。

### 8.4 Guidance staleness

在有代码变更之后，`QueryEngine` 还会调用 `detectPotentialStaleGuidance()` 检查已有 guidance 是否可能落后于代码。

它不会自动改写人工 guidance，但会向 sink 发出提示，让使用者知道：

- 哪些 guidance 文件可能过时了
- 为什么后续判断应该更多依赖实时工具结果，而不是只信已有说明

## 9. Verification 闭环

Merlion 的 verification 有两层。

### 9.1 Loop 内的 verification discipline

在 loop 里，verification 首先是一种“行为约束”：

- system prompt 明确要求尽量做强 verification
- loop 会跟踪是否出现过 verification-like tool call
- 如果已经有代码改动但没有任何 verification，可能会注入 verification hint

所以 verification 不是只在最后发生，它从一开始就在影响 agent 的收敛方向。

### 9.2 显式 verify rounds

CLI 非 REPL 模式下，如果启用了 `--verify`，`runner.ts` 会在主任务结束后走一轮显式验证：

1. `discoverVerificationChecks()` 自动发现可运行的检查项
2. `runVerificationChecks()` 执行这些检查
3. 如果失败，进入 `executeVerificationRound()`
4. `executeVerificationRound()` 调 `runVerificationFixRounds()`
5. 每一轮 fix 都会再回到 `runTurn(prompt)`，也就是重新进入同一个 agent runtime

这一步很关键：verification 不是“跑完告诉用户失败了”，而是可以把失败重新送回 agent，让它继续修。

因此，verification 在 Merlion 里是一个显式闭环：

```text
task run
  -> verification checks
  -> failed?
    -> fix prompt
    -> same agent runtime
    -> verification checks again
```

## 10. Transport 与展示层

Merlion 把“怎么和用户交互”尽量和 runtime 本身分开。

### 10.1 CLI

CLI 主要由这些层组成：

- `runner.ts`
- `runtime/sinks/cli.ts`
- `cli/*`

其中 sink 负责展示 turn、tool、usage、status 这些事件；runtime 本身只发事件，不关心终端怎么画。

### 10.2 WeChat

WeChat transport 在 `src/transport/wechat/run.ts`。

它做的事情包括：

- 登录和 token 管理
- polling updates
- sender queue
- sender-scoped history
- progress update 控制
- 构造 provider / registry / context service / query engine

WeChat 模式下，transport 和 runtime 仍然是分层的：

- transport 负责消息收发和每个 sender 的会话边界
- `QueryEngine` 负责真正的 agent 行为

这说明 WeChat 不是“另一套 agent”，只是另一种入口。

## 11. 关键设计判断

### 11.1 为什么不是 planner-heavy architecture

Merlion 没有单独的 planner subsystem，也没有 task graph。

当前做法是：

- 让模型自己完成局部规划
- 用 intent contract 和 runtime guardrails 去纠偏

这使得系统保持简单，但代价是很多收敛逻辑会体现在 loop guardrails 里，而不是一个干净的 planner/executor 边界里。

### 11.2 为什么 memory 主要靠 artifact，而不是 embedding retrieval

Merlion 当前更偏向显式 artifact：

- `AGENTS.md`
- `MERLION.md`
- `progress.md`
- `codebase_index.md`

这样做的好处是：

- 可读
- 可调试
- 可维护
- 教学价值高

代价是：

- 召回能力不如更复杂的 retrieval system
- 很多信息组织工作要靠 artifact 设计而不是向量索引

### 11.3 为什么 QueryEngine 是中心

如果没有 `QueryEngine`，你会得到一个很长的 `runner.ts` 和一个承载过多职责的 `loop.ts`。

把 conversation-scoped 逻辑收进 `QueryEngine` 后，边界会清楚很多：

- runner 负责 wiring
- loop 负责执行
- query engine 负责 runtime 生命周期
- context service 负责上下文

这是当前代码里最重要的结构性分层之一。

## 12. 当前架构的边界与短板

这份文档不只讲优点，也要把边界说清楚。

### 12.1 skills / memory state 还没有真正长成

`RuntimeState` 里已经有 `skills` 和 `memory` slices，但主流程目前主要使用的是：

- `permissions`
- `compact`

所以现在谈“Merlion 已经有完整 memory subsystem”是不准确的。更准确的说法是：它有 memory-ready runtime state 骨架，但尚未 fully operationalize。

### 12.2 ContextService 仍然偏胖

它现在同时负责：

- system prompt
- orientation bootstrap
- path guidance
- generated map mode

这让它很方便用，但也意味着“context”这个名字下面已经塞了几层不同职责。

### 12.3 Loop 仍然承载很多收敛逻辑

虽然 `loop_guardrails.ts` 已经把大量 helper 抽走，但 loop 的控制面还是比较重。尤其是：

- no-progress
- no-mutation
- exploration drift
- verification drift

这些都还是 runtime heuristics，而不是更高层状态机。

### 12.4 Verification 仍然是串行 fix-loop

当前 verification 闭环有效，但比较朴素：

- 发现 checks
- 运行
- 失败就 fix
- 再跑一轮

它还没有更细的 failure classification、test impact analysis 或 selective verification scheduling。

## 13. 一句话总结

Merlion 当前的架构可以概括成一句话：

它是一个以 `QueryEngine + ReAct loop + explicit repo-local context artifacts` 为中心的本地 coding agent runtime，用尽量少的层次，把上下文、工具、验证和会话状态接成一个仍然可以读清楚的系统。

如果把它和成熟产品比，它当然更薄；但正因为薄，很多关键设计决策在这里是看得见的。
