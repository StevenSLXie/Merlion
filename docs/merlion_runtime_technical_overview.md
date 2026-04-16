# Merlion Runtime Technical Overview

Status: `current implementation review + free-code comparison`  
Last Updated: `2026-04-16`

## Purpose

本文基于当前仓库真实实现，系统梳理以下主题：

1. agent loop 的设计与工程优化
2. 记忆与索引系统
3. 工具体系与统一 tool registry
4. MCP / skill 支持现状
5. 与 `https://github.com/paoloanzn/free-code/tree/main/src` 的逐项对比，以及可落地借鉴点

目标不是重复愿景文档，而是给后续开发、索引、重构和评审提供一份“实现态”文档。

## TL;DR

Merlion 当前已经形成一个可工作的单 agent CLI runtime，核心特点是：

- 以 `src/bootstrap/cli_args.ts` + `src/bootstrap/config_resolver.ts` 负责入口解析与配置解析。
- 以 `src/runtime/query_engine.ts` 为中心承接 conversation-scoped runtime state 与单请求提交流程。
- 以 `src/runtime/loop.ts` 为中心的同步 ReAct loop。
- 以 `src/runtime/runner.ts` 负责 CLI runtime wiring，并把任务分发给 `QueryEngine` + task runtime。
- 以 `src/runtime/tasks/**` 负责最小 task runtime，把 `local_turn / verify_round / wechat_message` 从 runner 中拆出。
- 以 `src/runtime/sinks/cli.ts` / `src/runtime/sinks/wechat.ts` 承接展示层和 transport 启动适配。
- 以 `src/runtime/executor.ts` + `src/tools/registry.ts` 为中心的统一工具执行面。
- 以 `.merlion/progress.md`、`.merlion/codebase_index.md`、`.merlion/maps/**` 为中心的 repo-local 轻量记忆/索引层。
- 以 `src/context/service.ts` 为中心统一 system prompt、orientation bootstrap、path guidance、trust-gated prefetch。
- 以 `src/runtime/state/**` 为中心收拢 permission / compact / skill / memory runtime state。
- 以 `src/runtime/input/**` 为中心把 REPL 输入先做 preprocessing，再决定是否进入 agent loop。
- 以薄 `src/index.ts` 作为 main wiring，避免入口继续承载全部业务编排。

同时也有明确短板：

- 主编排已从 `src/index.ts` 抽出，且 `runner` 不再直接持有大部分会话状态；但 task runtime 仍是最小版，还没有完整 task graph / kill / list / status。
- 虽然已引入 `tool catalog + tool pool assembly`，但当前过滤维度仍是首版，仅覆盖 `default/wechat` mode 与显式 include/exclude，离 free-code 那种完整 pool、deny-rule、MCP 合并层还有距离。
- skill / MCP 在当前仓库中仍主要停留在设计和兼容性预留，没有真正落地到 runtime。
- 记忆系统偏“结构化轻量 artifact + runtime state slices”，还不是 free-code 那种更完整的会话上下文基础设施。

---

## 1. Agent Loop 设计

### 1.1 核心模块与调用链

当前主链路由以下模块构成：

- `src/index.ts`
-  - 薄入口，只做 CLI bootstrapping。
- `src/runtime/runner.ts`
  - 完成 provider / registry / sink / session file / QueryEngine / task runtime 的组装。
- `src/runtime/query_engine.ts`
  - 持有 conversation-scoped history、runtime state、tracked permissions、context bootstrap。
- `src/runtime/loop.ts`
  - 负责单轮到多轮的 ReAct 主循环。
- `src/runtime/executor.ts`
  - 负责工具调用分批、并发执行、结果回填。
- `src/runtime/tasks/**`
  - 负责 `local_turn`、`verify_round`、`wechat_message` 等任务分发。
- `src/context/service.ts`
  - 负责 system prompt 缓存、trust-gated prefetch、prompt prelude、path guidance 增量注入。
- `src/providers/openai.ts`
  - 负责将消息与工具 schema 转成 OpenAI-compatible `/chat/completions` 请求。

单次用户请求的实际数据流：

1. `runner.ts` 构造 `provider`、`registry`、`ContextService`、`QueryEngine`
2. 输入先经过 `src/runtime/input/process.ts`，决定是本地动作、shell shortcut、slash command，还是进入 prompt 提交
3. `runner` 通过 `RuntimeTaskRegistry` 把请求分派为 `local_turn / verify_round / wechat_message`
4. `QueryEngine` 初始化 system prompt、bootstrap context、tracked permissions、runtime state
5. `QueryEngine.submitPrompt()` 调用 `runLoop()`
6. `runLoop()` 把 `state.messages` 发给 provider，并携带 `registry.getAll()` 的工具 schema
7. 模型返回：
   - 如果 `finish_reason === 'tool_calls'`，进入 `executeToolCalls()`
   - 否则结束当前请求
8. 工具结果以 `role: 'tool'` 消息回填到 `state.messages`
9. `QueryEngine` 在回合后统一更新 path guidance / codebase index / progress / compact state / permission state
10. 继续下一轮，直到得到最终文本或触发 terminal condition

### 1.2 Loop State

`src/runtime/loop.ts` 的 `LoopState` 仍然是轻量状态机：

- `messages`
- `turnCount`
- `maxOutputTokensRecoveryCount`
- `hasAttemptedReactiveCompact`
- `nudgeCount`

但现在外层已经补上了 `QueryEngine` 的 conversation-scoped runtime state：

- `permissions`
- `compact`
- `skills`
- `memory`

这意味着当前 runtime 已经不再是“所有状态都挂在 loop 局部变量里”，而是采用“两层状态”：

- `LoopState`: 单次 `runLoop()` 的瞬时控制状态
- `RuntimeState`: 横跨一个 conversation / session 的结构化运行时状态

这说明当前 runtime 采用的是“保持 loop 简洁，但把跨回合状态外移”的做法：

- 不引入额外 query object / task object
- 不做多层 actor state machine
- 不做 SDK-style streaming lifecycle

优点：

- 实现面收敛，便于测试。
- terminal condition 清晰，当前只有 `completed | max_turns_exceeded | model_error`。
- 对现有 CLI / verify / REPL 接入足够直接。

代价：

- `runLoop()` 内仍有不少局部 guardrail 状态，离完全 runtime-owned 还有距离。
- skill / memory 虽然已预留 runtime state slice，但暂未真正接入激活和重放逻辑。

### 1.3 当前 loop 的工程优化

#### 1.3.1 Reactive compact，但保持极简

`src/context/compact.ts` + `src/runtime/loop.ts`

实现方式：

- 通过 `estimateMessagesChars()` 估算历史消息大小。
- 当字符量超过 `MERLION_COMPACT_TRIGGER_CHARS`，触发一次 `compactMessages()`。
- 保留首个 system message 和最近 N 条消息。
- 将中间历史压缩成一条 summary-style system message。

特点：

- 零额外 LLM 调用。
- 防止历史消息无限膨胀。
- 用 `hasAttemptedReactiveCompact` 防止重复 compact 循环。

这属于“工程上可接受的最小版 compaction”，不是 free-code 那种多阶段 history snip / microcompact / server-side cache edit。

#### 1.3.2 False-start nudge

`src/runtime/loop.ts`

当前 loop 会识别一种常见失败模式：模型说“我先看一下/我来检查一下”，但没有任何 tool call。

实现点：

- 用多语言正则识别 action intent、action verb、completion hint、ack hint。
- `shouldNudge()` 在严格条件下返回 true。
- 最多只注入两次 nudge，避免形成新的 loop。

收益：

- 对中文和英文都做了兼容。
- 可以压制“空话式推进”。
- 代价很低，不需要额外模型调用。

#### 1.3.3 Tool error repetition guard

`src/runtime/loop.ts`

当前 loop 会追踪同一 tool call signature 的重复失败次数：

- 对 tool name + normalized arguments 做 signature。
- 连续相同失败达到阈值后，自动插入纠偏 user message。
- 提示模型先 `list_dir` / `stat_path` 校验路径，不要继续重复错误调用。

这是一个很实用的工程优化，因为 CLI coding agent 的高频失败往往不是“复杂推理错误”，而是“错误路径 + 错误参数反复重试”。

#### 1.3.4 No-progress batch detection

`src/runtime/loop.ts`

如果连续多个 tool batch 全失败：

- 统计 `consecutiveAllErrorBatches`
- 达到阈值后，自动插入 re-plan 型 user message

提示内容比较明确：

- 先重规划 2-3 步
- 用 `list_dir` / `stat_path` 验证路径
- 再执行一个最小动作

这类 guardrail 对当前单 agent runtime 很关键，因为它在没有 planner 层的情况下，替代了一部分“任务状态回退”能力。

#### 1.3.5 Mutation oscillation detection

`src/runtime/loop.ts`

当前 loop 还会追踪成功的文件操作序列：

- `create/write/append/edit` 视为 `materialize`
- `delete` 视为 `remove`
- `move` 视为 `move`

如果出现：

- 同一路径 materialize/remove 来回切换
- 或 move A->B 后又 move B->A

就会插入纠偏提示，阻止“改了又删、删了又建”的震荡行为。

这是非常偏工程经验的优化，说明当前 runtime 已经开始针对真实 agent 失控模式做 hardening。

#### 1.3.6 Empty-stop recovery

`src/runtime/loop.ts`

模型在工具调用后有时会返回空文本 stop。当前实现不是直接把空字符串当成功，而是：

1. 先追加一条“请写自然语言总结”的 user message
2. 再请求模型补一轮 final summary
3. 如果仍为空，则回退到 synthetic summary

这让 CLI 在 terminal 阶段更稳定，避免工具执行完但最终输出为空。

#### 1.3.7 Bug-fix source-first guardrails

`src/runtime/intent_contract.ts` + `src/runtime/loop.ts` + `src/prompt/system_prompt.ts`

当前 runtime 已补上两层 bug-fix-specific guardrail，用来解决真实 benchmark 中暴露出的“修 bug 时探索过长、迟迟不进入有效 source mutation”问题：

1. system prompt + intent contract
   - 当任务看起来像 bug-fix / regression repair 时，显式强调：
     - tests/logs/repro steps 是 specification
     - 优先改 implementation/source
     - 不要先改测试，除非用户明确要求或证据很强
2. loop-level convergence hint
   - bug-fix 模式下，如果连续多个 tool batch 没有任何成功文件修改，会比普通 no-mutation hint 更早触发
   - 提示模型停止 broad exploration，收敛到一个最可能的 implementation file，并做一次最小 source edit
3. first test-only mutation hint
   - bug-fix 模式下，如果第一次成功 mutation 只触达 test-like path，会追加纠偏提示，防止测试先行漂移

这类 guardrail 的价值在于：

- 不针对某个 benchmark 项目写死
- 但能把 coding agent 在修 bug 场景里的优先级拉回“先定位实现、再做最小补丁”

#### 1.3.8 Retry、budget、observability

相关模块：

- `src/runtime/retry.ts`
- `src/runtime/budget.ts`
- `src/runtime/prompt_observability.ts`
- `src/runtime/usage.ts`

当前 runtime 还做了三类辅助优化：

- provider 调用带重试
- tool result 进入消息前会走预算裁剪
- 每轮可记录 prompt 观测信息与 usage，并落到 session usage JSONL

这几项虽然不是 loop 主逻辑，但对工程质量很关键：

- 防止单次 provider 波动直接终止 session
- 控制 tool result 过大导致的 token 爆炸
- 为后续成本和 cache 诊断留数据

### 1.4 Tool execution model

`src/runtime/executor.ts`

工具执行器目前采用“两级模型”：

1. 先按 `concurrencySafe` 分批
2. 对安全批次进行并发 worker 执行
3. 对非安全工具串行执行
4. 最终按原始 tool call 顺序回排结果

这个设计的关键点：

- 并发控制是 registry metadata 驱动的，而不是 hardcode 某几个工具。
- 执行顺序和返回顺序解耦。
- `ToolCallStartEvent` / `ToolCallResultEvent` 作为 runtime hook 的统一事件载体。

它已经具备比较好的扩展基础，尤其适合继续往“事件总线”演进。

### 1.5 Loop 设计的当前长处

- 结构简单，可读性好，核心路径集中。
- Guardrails 已经覆盖了若干真实 agent 失控模式。
- orientation、path guidance、artifact 更新都通过 hooks 接入，没有侵入 provider 层。
- 终态恢复比很多最小 CLI agent 更完整。

### 1.6 Loop 设计的当前短板

- `index.ts` 过重，runtime orchestration 没有抽成 runner/task 层。
- 缺少 free-code 那种“query engine owns session lifecycle”的统一抽象。
- 当前 provider 是单一 OpenAI-compatible 实现，loop 与 provider contract 绑定偏紧。
- 还没有真正的 streaming turn model，也没有分层 task runtime。

---

## 2. 记忆与索引系统

Merlion 目前的“记忆”并不是统一 memory engine，而是三层并行结构：

1. session transcript / usage
2. repo-local progress / codebase index
3. generated guidance maps

### 2.1 Session transcript：会话级记忆

模块：`src/runtime/session.ts`

当前实现：

- 为每个 session 生成 `.jsonl` transcript 和 `.usage.jsonl`
- transcript 中记录：
  - `session_meta`
  - `message`
- 写入前对 message 做 secret redaction
- resume 时从 transcript 恢复历史消息

特点：

- 这是“对话记忆”，不是“知识记忆”。
- 存储是 append-only JSONL，适合调试和恢复。
- resume 能力依赖 transcript，而不是依赖模型端会话状态。

当前价值：

- 为 REPL 和 `--resume` 提供真实持久化基础。
- 也为 prompt observability / cost analysis 提供数据基础。

### 2.2 Progress artifact：任务级轻量记忆

模块：

- `src/artifacts/progress.ts`
- `src/artifacts/progress_auto.ts`

产物路径：

- `.merlion/progress.md`

结构化内容：

- `Objective`
- `Done`
- `Next`
- `Blockers`
- `Decisions`

特点：

- 用 markdown，而不是 JSON 或数据库。
- 可被 orientation 直接注入 system context。
- 支持 runtime signals 自动更新，例如：
  - changed files
  - successful git commit

这类 artifact 的定位不是长期 memory，而是“项目内可读的运行快照”。

### 2.3 Codebase index：结构索引

模块：`src/artifacts/codebase_index.ts`

产物路径：

- `.merlion/codebase_index.md`

当前索引内容包括：

- Top-level
- Directory Summary
- Dev Scripts
- Guidance Scopes
- File Map (sample)
- Recent Changed Files

构建方式：

- 扫描 top-level entries
- 读取 `package.json` scripts
- 对 top-level 目录做 purpose inference
- 从优先目录采样文件图
- 收集 guidance scope
- 记录最近变更文件及其最近 commit note

这是当前 Merlion 最有特色的 repo-local 记忆层之一，因为它不是简单文件树，而是“结构 + 语义 + 最近变更”的混合摘要。

### 2.4 Repo semantics：索引构建的语义推断层

模块：`src/artifacts/repo_semantics.ts`

作用：

- 估算仓库文件数
- 根据规模动态调 orientation budget
- 推断目录 purpose
- 为 generated maps 和 codebase index 复用目录语义逻辑

这意味着 Merlion 的 index 不是死板的树遍历，而是加入了少量启发式语义分析。

### 2.5 AGENTS / generated maps：路径级工作记忆

模块：

- `src/artifacts/agents.ts`
- `src/artifacts/agents_bootstrap.ts`
- `src/context/path_guidance.ts`
- `src/artifacts/guidance_staleness.ts`

当前体系分为两种 guidance 来源：

- 项目真实 `AGENTS.md` / `MERLION.md`
- 自动生成的 `.merlion/maps/**/MERLION.md`

工作方式分两段：

#### 启动阶段：orientation

`src/context/orientation.ts`

- 读取 root + major scopes guidance
- 读取 progress artifact
- 读取 codebase index
- 按 token budget 组装为 orientation context
- 作为 system message 注入初始历史

#### 运行阶段：path guidance delta

`src/context/path_guidance.ts`

- 从 tool args / tool output 中提取 candidate paths
- 根据路径构建从 root 到目标目录的 guidance chain
- 只加载尚未注入过的 guidance 文件
- 按总 budget、单文件 budget、最大文件数裁剪
- 生成增量 system message 回注 loop

这相当于一种“路径驱动的局部记忆加载”，是 Merlion 当前上下文系统的核心优化。

### 2.6 自动维护链路

`src/index.ts` 在每次请求后还会联动维护：

- `updateCodebaseIndexWithChangedFiles()`
- `updateProgressFromRuntimeSignals()`
- `detectPotentialStaleGuidance()`
- `ensureGeneratedAgentsMaps()`

这说明当前架构的一个重要特点是：

- 记忆和索引不是独立后台系统
- 而是挂在 runtime event / tool batch / request completion 的生命周期上做增量维护

### 2.7 当前系统的强项

- 全部 repo-local，可读、可检查、可 git diff。
- orientation + path guidance 是闭环的，不只是一次性启动提示。
- progress、index、map 三种 artifact 各自职责清晰。
- 很适合中小型代码库冷启动和多轮维护。

### 2.8 当前系统的短板

- 还没有统一 memory abstraction。
- 没有检索索引、embedding、vector store、symbol index。
- session transcript 与 repo artifact 之间没有统一视图。
- artifact 刷新逻辑散落在 `index.ts`，还不是独立 memory/index service。

---

## 3. 工具体系与统一 Tool Registry

### 3.1 当前工具总览

模块入口：`src/tools/builtin/index.ts`

当前内置工具可分为四类：

#### 文件与导航

- `read_file`
- `list_dir`
- `stat_path`
- `search`
- `grep`
- `glob`

#### 文件写操作

- `write_file`
- `append_file`
- `create_file`
- `edit_file`
- `copy_file`
- `move_file`
- `delete_file`
- `mkdir`

#### 执行与 Git

- `bash`
- `run_script`
- `list_scripts`
- `git_status`
- `git_diff`
- `git_log`

#### 元工具 / 生产力工具

- `fetch`
- `lsp`
- `tool_search`
- `todo_write`
- `ask_user_question`
- `config`
- `config_get`
- `config_set`
- `sleep`

### 3.2 catalog / pool / registry 的分层

当前工具装配已拆成三层：

- `src/tools/catalog.ts`
  - 定义 builtin tools 的完整稳定清单
- `src/tools/pool.ts`
  - 基于 mode / include / exclude 组装本轮真正暴露给模型的工具集合
- `src/tools/registry.ts`
  - 只负责注册、查找和按顺序返回，不承担过滤职责

首版 `tool pool` 已支持：

- `default` mode
- `wechat` mode
- `includeNames`
- `excludeNames`

其中 `wechat` mode 当前会把 `config`、`config_get`、`config_set` 从模型可见工具集合中移除。

### 3.3 统一 registry 的边界

模块：

- `src/tools/types.ts`
- `src/tools/registry.ts`

当前 `ToolDefinition` 的统一字段：

- `name`
- `description`
- `source?`
- `searchHint?`
- `isReadOnly?`
- `isDestructive?`
- `requiresUserInteraction?`
- `requiresTrustedWorkspace?`
- `parameters`
- `concurrencySafe`
- `execute(input, ctx)`

`ToolContext` 当前提供：

- `cwd`
- `sessionId?`
- `permissions?`
- `listTools?`
- `askQuestions?`

当前 contract 已经从“只够执行”扩到“也能表达基础策略属性”，但仍保持兼容：metadata 字段全部是可选的。

另外，builtin metadata 当前统一由 `src/tools/catalog.ts` 汇总，而不是散落在每个工具文件中。

### 3.4 registry 的现状：简单但稳定

`src/tools/registry.ts`

当前 registry 能力只有三件事：

- 注册
- 按名获取
- 获取全部工具

其关键性质是：

- 插入顺序稳定
- 重复注册直接报错

结合测试 `tests/tool_registry.test.ts`，可以认为当前 registry 的设计目标是“稳定、可预测”，而不是“动态、智能”。

### 3.5 executor 如何消费 registry

`src/runtime/executor.ts`

executor 对 registry 的依赖主要有两点：

- 用 `registry.get(name)` 找到工具定义
- 用 `concurrencySafe` 决定 batching 和并发

额外一个细节是：

- `ToolContext.listTools()` 会把 `registry.getAll()` 暴露给工具本身
- `tool_search` 正是通过这个上下文拿到当前可见工具集合

这说明当前 registry 虽简单，但已经是“工具可见性”的单一事实源。

而且现在 `tool_search` 已经会消费 `searchHint`，说明 metadata 已经开始产生实际收益，而不是纯预留字段。

### 3.6 典型工具设计细节

#### `bash`

模块：`src/tools/builtin/bash.ts`

特点：

- 做 command normalization
- 做 risk assessment：`safe | warn | block`
- 对高风险命令直接拒绝
- 对警告级命令触发 permission gate
- 控制 timeout
- 合并 stdout/stderr
- 做输出截断

这是当前最关键的高风险工具之一，也是 runtime 安全边界的重要组成部分。

#### `tool_search`

模块：`src/tools/builtin/tool_search.ts`

特点：

- 支持 query-based 检索
- 支持 `select:<tool_name>` 精确选择
- 基于工具名、描述和 `searchHint` 做评分
- 不依赖硬编码工具列表

虽然当前工具总数不算大，但这个工具为后续 deferred tool / MCP tool 扩容预留了模型侧使用路径。

#### `lsp`

模块：`src/tools/builtin/lsp.ts`

特点：

- 首版基于本地 `typescript` runtime 做 JS/TS 语义分析
- 支持 `definition`、`references`、`hover`
- 支持 `document_symbols`、`workspace_symbols`、`diagnostics`
- 输入输出统一使用 1-based 行列号
- 会按 `cwd` 复用 project service，并在文件 mtime 变化时刷新版本

这让 Merlion 从“主要依赖文本搜索”前进到“具备基础语义导航能力”，对跨文件定位和调试收益很直接。

#### `ask_user_question`

模块：

- `src/tools/builtin/ask_user_question.ts`
- `src/runtime/ask_user_question.ts`

特点：

- 支持 1-3 个结构化问题批次
- 每题包含 `header/id/question/options`
- 支持单选、多选和自由文本回填
- 通过 `ToolContext.askQuestions()` 把交互能力从具体 runtime 注入工具层
- 在 `wechat` pool 中会因为 `requiresUserInteraction` 被预过滤掉

这个工具把“澄清需求”从 assistant prose 变成了可测试、可回放的显式 runtime 行为。

#### 文件操作工具

多数文件工具复用了：

- `src/tools/builtin/fs_common.ts`
- `src/tools/builtin/process_common.ts`

设计倾向很明确：

- 所有文件写入都应受 workspace 边界约束
- 执行类工具共享 timeout / output truncation / process handling

### 3.7 当前 tool catalog / pool / registry 的强项

- 已经把“工具全集”和“当前会话可见工具集合”分开。
- 统一 contract 清晰。
- 内置工具覆盖了 coding agent 最核心路径。
- `lsp` 把代码定位能力从文本级提升到语义级。
- `ask_user_question` 让高不确定性任务可以显式澄清，而不是只能猜。
- `concurrencySafe` 元数据已经足以支持 executor batching。
- `tool_search`、permission、usage budget 已经与 registry 形成闭环。

### 3.8 当前 tool catalog / pool / registry 的短板

- 当前 catalog 仍只有 builtin 来源。
- pool 过滤维度还比较薄，没有 deny-rule prefilter、feature flag、MCP merge。
- 还没有 builtin / extension / MCP 三层来源模型。
- 虽然已有 metadata contract，但还不足以支撑 deferred loading、MCP provenance、trust policy、richer UI 展示的完整闭环。

---

## 4. MCP / Skill 支持现状

这一部分必须区分“当前实现”和“设计目标”。

### 4.1 当前真实实现状态

基于当前 `src/` 代码：

- 没有 MCP client/runtime
- 没有 MCP tool discovery / registration
- 没有 MCP resource bridge
- 没有 skill discovery / activation / injection
- 没有 plugin runtime

当前仓库中与 MCP / skill 相关的内容主要存在于：

- `docs/initial_design.md`
- `docs/phase1_technical_design.md`
- `docs/initial_design_review.md`

换句话说，这一层目前还是“规划中的能力”，不是已交付能力。

### 4.2 当前已经具备的前置条件

虽然 MCP / skill 未真正实现，但目前代码已经有几项重要铺垫：

#### 统一 tool contract

`src/tools/types.ts`

MCP 工具要接入，至少需要一个统一 `ToolDefinition` 适配层。当前这一层已经存在。

#### `tool_search`

`src/tools/builtin/tool_search.ts`

如果未来 MCP 工具数量上来，`tool_search` 可以作为 deferred loading / tool narrowing 的模型侧入口。

#### prompt section registry

`src/prompt/sections.ts`

如果未来要把 skill catalog、MCP catalog、dynamic prompt parts 注入 system prompt，这一层已经能承载“可缓存 section”的组装逻辑。

#### orientation / path guidance 机制

`src/context/orientation.ts` 和 `src/context/path_guidance.ts`

这套机制未来也可以承载 skill / MCP 的“只在需要时增量注入”。

### 4.3 当前缺失的关键能力

如果要真正支持 MCP / skill，当前至少还缺这些模块：

#### MCP 侧

- server config / connection lifecycle
- tool discovery 和 schema normalization
- MCP tool 与 builtin tool 的统一 tool pool 合并
- resource list / read API
- defer loading / always load 策略
- server-scoped deny / allow 规则

#### skill 侧

- skill catalog discovery
- SKILL.md progressive disclosure
- skill activation tool 或直接文件读取策略
- token budget 与重注入策略
- project-level trust boundary

### 4.4 实事求是的结论

当前如果说“Merlion 支持 MCP / skill”，是不准确的。更准确的表述应该是：

- Merlion 已经为 MCP / skill 做了设计和若干底层铺垫
- 但 runtime 级支持尚未落地

这个区分在后续路线图、PR 说明和对外介绍里都应该保持一致。

---

## 5. 与 free-code 的对比

比较基线：

- `free-code/src/main.tsx`
- `free-code/src/tools.ts`
- `free-code/src/Tool.ts`
- `free-code/src/context.ts`
- `free-code/src/QueryEngine.ts`

### 5.1 总体判断

free-code 更像“完整 CLI/SDK/runtime 平台”，Merlion 更像“聚焦 coding loop 的轻量工程化实现”。

两者差别不只是功能多少，更是架构成熟度不同：

- free-code：runtime 基础设施更厚，扩展点更多
- Merlion：核心链路更短，可读性更好，更适合快速迭代本地 coding agent 能力

### 5.2 Merlion 的长处

#### 长处 1：repo-local orientation / path guidance 更成体系

Merlion 当前最有辨识度的部分不是 loop 本身，而是：

- orientation 装配
- generated maps
- path-guided AGENTS delta
- codebase index / progress 双 artifact

free-code 更强调系统 prompt、工具池、memory files、conversation engine，而 Merlion 在“项目本地索引与路径级 guidance”上做得更具体。

这对中小仓库很实用，因为它降低了冷启动成本，也让 agent 更容易走“先缩小目录范围，再扩大搜索”的路径。

#### 长处 2：artifact 可见性强

Merlion 把很多状态落到 `.merlion/`：

- `progress.md`
- `codebase_index.md`
- `maps/**`
- `sessions/*.jsonl`

这让开发者更容易审查 agent 的结构性记忆，而不是只能依赖黑盒状态。

#### 长处 3：loop guardrails 已经针对真实问题做了定向 hardening

例如：

- repeated tool error detection
- no-progress detection
- mutation oscillation detection
- empty-stop recovery

这些都很“工程现场”，说明当前实现已经不是纯 demo。

### 5.3 Merlion 的短板

#### 短板 1：入口过重，缺少 QueryEngine / task runtime 抽象

当前 `src/index.ts` 约 923 行，承担：

- 参数解析
- 配置加载
- 模式分发
- session 初始化
- orientation 注入
- event wiring
- artifact 自动维护
- REPL / verify / WeChat 接入

free-code 的主入口虽然复杂，但它已经有更明显的分层和运行时组织对象。Merlion 现在还在“入口总编排文件”阶段。

#### 短板 2：tool pool 能力明显弱于 free-code

free-code 的 `src/tools.ts` 有几个 Merlion 目前没有的关键点：

- `getAllBaseTools()` 作为单一工具源
- `filterToolsByDenyRules()` 在模型看到工具前预过滤
- `getTools()` 根据模式和环境选择工具
- `assembleToolPool()` 合并 builtin + MCP，并保证 builtins 作为稳定前缀

Merlion 当前只有：

- 静态 `buildDefaultRegistry()`
- 没有 tool pool assembly
- 没有 builtin / MCP 合并层
- 没有 prompt-cache-aware 排序策略

#### 短板 3：tool metadata 过薄

free-code 的 `Tool` 类型有大量 runtime metadata：

- `isReadOnly`
- `isDestructive`
- `requiresUserInteraction`
- `isMcp`
- `isLsp`
- `shouldDefer`
- `alwaysLoad`
- `mcpInfo`
- `interruptBehavior`
- `isSearchOrReadCommand`

Merlion 当前只有：

- `name`
- `description`
- `parameters`
- `concurrencySafe`
- `execute`

这足够支撑当前内置工具，但不够支撑更复杂的 tool ecosystem。

#### 短板 4：MCP / skill 还未落地

free-code 的 `tools.ts` 明确已经把这些能力纳入统一工具装配面：

- `SkillTool`
- `ListMcpResourcesTool`
- `ReadMcpResourceTool`
- `assembleToolPool(permissionContext, mcpTools)`

而 Merlion 目前仍停留在设计文档阶段。

#### 短板 5：system/user context 基础设施不如 free-code 完整

free-code 的 `src/context.ts` 已经体现出：

- system context / user context 分层
- memoize/cache
- git status snapshot
- memory file / CLAUDE.md 注入

Merlion 当前虽然有 prompt section cache 和 orientation，但还没有完整的 conversation-scoped context service。

### 5.4 哪些地方应该借鉴 free-code

这里重点写“具体到可落地实现”的借鉴项。

#### 借鉴 1：把静态 registry 升级为 tool catalog + tool pool assembly

建议新增：

- `src/tools/catalog.ts`
- `src/tools/pool.ts`

建议职责：

- `catalog.ts`
  - 列出所有 builtin tool definition
  - 后续也能挂 MCP/extension adapter
- `pool.ts`
  - 接收 mode、permission、env、feature flag
  - 输出当前会话真正暴露给模型的工具池

必须补的细节：

- 先过滤再注入模型，减少 schema 噪音
- 稳定排序，避免工具顺序抖动影响 prompt cache
- 保持 builtin prefix 连续，为未来 MCP 加入做准备

这正是 free-code `getAllBaseTools()` / `getTools()` / `assembleToolPool()` 值得借鉴的部分。

#### 借鉴 2：补强 ToolDefinition metadata，而不是直接上 MCP

不建议直接先做 MCP client，建议先扩 `src/tools/types.ts`。

建议新增字段：

- `source: 'builtin' | 'mcp' | 'extension'`
- `isReadOnly?: boolean`
- `isDestructive?: boolean`
- `requiresUserInteraction?: boolean`
- `shouldDefer?: boolean`
- `alwaysLoad?: boolean`
- `searchHint?: string`
- `mcpInfo?: { serverName: string; toolName: string }`

理由：

- 先把 registry contract 拉平，后续接 MCP/skill 才不会返工 executor、pool、prompt assembler。
- `tool_search` 也能立即利用 `searchHint` 提升检索质量。

#### 借鉴 3：把 `index.ts` 拆成 bootstrap / runtime runner / sinks

这是当前最值得尽快做的重构项。

建议拆分：

- `src/bootstrap/cli_args.ts`
- `src/bootstrap/config_resolver.ts`
- `src/runtime/runner.ts`
- `src/runtime/events.ts`
- `src/runtime/sinks/cli.ts`
- `src/runtime/sinks/wechat.ts`

拆分目标：

- `index.ts` 只保留 main + wiring
- artifact lifecycle 与 UI 输出分离
- REPL / single-shot / WeChat 共享同一 runtime event 源

这个方向已经在 `docs/features/066-free-code-runtime-landing-plan.md` 里提出，应该继续推进。

#### 借鉴 4：引入最小 Task runtime，而不是继续堆 callback

当前 verify、WeChat message handling、单次 turn 都在 `index.ts` 里通过局部函数和回调拼装。

建议最小化新增：

- `local_turn`
- `verify_round`
- `wechat_message`

每个 task 都有统一状态：

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

这样做的价值不是抽象本身，而是把“生命周期”和“显示层”解耦。

#### 借鉴 5：MCP 上线前先做 deferred tool contract

当前 Merlion 已经有 `tool_search`，这正好是最好的切入点。

建议顺序：

1. 扩 tool metadata，支持 `shouldDefer`
2. 在 prompt assembler 层支持“部分工具只露出 catalog，不露 schema”
3. 让 `tool_search` 成为 deferred tool 的入口
4. 最后再接入 MCP tool adapter

这样做能避免“MCP 一上来就把系统 prompt 撑爆”的问题。

这正是 free-code 在工具池和 ToolSearch 设计上最值得借鉴的细节，不是为了抄功能，而是为了控制 token 成本和 prompt 稳定性。

#### 借鉴 6：Skill 不要先做“自动注入”，先做 catalog + 激活

free-code 已经把 `SkillTool` 纳入工具体系。Merlion 如果要做 skill，建议不要一开始就自动注入全文。

建议分三步：

1. 发现可用 skill，只暴露 `name + description + path`
2. 通过 `activate_skill` 或 `read_file(SKILL.md)` 显式激活
3. 激活后再纳入 path guidance / prompt section cache

要点：

- 先解决 progressive disclosure
- 再解决 token budget
- 最后解决自动触发准确率

#### 借鉴 7：把 repo-local artifact 继续做成 Merlion 的差异化优势

这里不是向 free-code 学，而是反过来坚持 Merlion 自己的优势：

- 保持 `.merlion/progress.md`
- 保持 `.merlion/codebase_index.md`
- 保持 `.merlion/maps/**`
- 继续强化 path-guided loading

真正值得做的是把这些 artifact 接到更正式的 runtime service 上，而不是退回黑盒 memory。

### 5.5 一个更实际的优先级排序

如果只按 ROI 排序，我建议是：

1. 先拆 `index.ts`
2. 再做 tool catalog / tool pool assembly
3. 再扩 `ToolDefinition` metadata
4. 再做最小 task runtime
5. 最后接 skill / MCP

原因很简单：

- 现在最大的阻力不是“少了 MCP”，而是“已有 runtime 扩展成本已经开始变高”

---

## 6. 面向后续索引的结论

### 6.1 现阶段对 Merlion 的最准确定义

Merlion 当前是一个：

- 以单 agent ReAct loop 为核心
- 带有 repo-local orientation / progress / index / generated maps
- 带有较强 loop guardrails
- 但尚未具备完整 MCP / skill / task runtime 的 CLI coding agent

### 6.2 最值得保留的实现资产

- `src/runtime/loop.ts` 的 guardrails
- `src/runtime/executor.ts` 的 concurrency-safe batching
- `src/context/orientation.ts` + `src/context/path_guidance.ts`
- `src/artifacts/codebase_index.ts`
- `src/artifacts/agents_bootstrap.ts`

### 6.3 最需要尽快重构的区域

- `src/index.ts`
- `src/tools/registry.ts` 周边能力
- memory/index/artifact 生命周期的组织方式

### 6.4 和 free-code 对比后的核心路线

不是去复制 free-code 的所有能力，而是按这个顺序演进：

1. 入口拆层
2. tool pool
3. richer tool metadata
4. minimal task runtime
5. deferred tools
6. skill / MCP

这样做可以最大限度复用当前 Merlion 已经做对的东西，而不是把仓库带回“大而全但难维护”的状态。

---

## Appendix: Source Index

### Merlion local sources

- `src/bootstrap/cli_args.ts`
- `src/bootstrap/config_resolver.ts`
- `src/cli/commands.ts`
- `src/cli/completion.ts`
- `src/cli/input_buffer.ts`
- `src/index.ts`
- `src/tools/catalog.ts`
- `src/tools/pool.ts`
- `src/runtime/events.ts`
- `src/runtime/runner.ts`
- `src/runtime/sinks/cli.ts`
- `src/runtime/sinks/wechat.ts`
- `src/runtime/loop.ts`
- `src/runtime/executor.ts`
- `src/runtime/session.ts`
- `src/context/orientation.ts`
- `src/context/path_guidance.ts`
- `src/context/compact.ts`
- `src/artifacts/agents.ts`
- `src/artifacts/agents_bootstrap.ts`
- `src/artifacts/progress.ts`
- `src/artifacts/progress_auto.ts`
- `src/artifacts/codebase_index.ts`
- `src/artifacts/repo_semantics.ts`
- `src/artifacts/guidance_staleness.ts`
- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/builtin/index.ts`
- `src/tools/builtin/tool_search.ts`
- `src/tools/builtin/bash.ts`
- `src/prompt/sections.ts`
- `src/prompt/system_prompt.ts`

### Merlion tests

- `tests/runtime_loop.test.ts`
- `tests/tool_registry.test.ts`
- `tests/artifacts_codebase_index.test.ts`
- `tests/path_guidance.test.ts`

### free-code reference sources

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/tools.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/Tool.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/context.ts`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/main.tsx`
- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`
