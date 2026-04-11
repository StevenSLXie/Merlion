# CLI Coding Agent — 完整调研文档

> **项目定位：** 开源 CLI coding agent，对标 Claude Code + OpenClaw，TypeScript/Node，model-agnostic，cost-aware
> **核心原则：** 学骨架，不全抄，从第一天起模块化；context engine 作为一等公民
> **参考基准：** FreeCode（Claude Code 可编译 fork）、Anthropic 工程博客、agentskills.io 开放标准

---

## 目录

1. [ReAct Agent 主循环](#1-react-agent-主循环)
2. [基础工具](#2-基础工具)
3. [记忆管理](#3-记忆管理)
4. [上下文管理](#4-上下文管理)
5. [工具管理与 Tool Registry](#5-工具管理与-tool-registry)
6. [Skill 系统](#6-skill-系统)
7. [Codebase Index（新 Session 冷启动）](#7-codebase-index新-session-冷启动)
8. [Hook 系统](#8-hook-系统)
9. [Harness 思想与各方向补强](#9-harness-思想与各方向补强)
10. [CLI 渲染](#10-cli-渲染)
11. [附录：资源索引](#11-附录资源索引)

---

## 1. ReAct Agent 主循环

### 1.1 最小 Loop 与 QueryEngine 架构

**来源：** FreeCode 逆向，instructkr/claude-code 深度分析

**最小 Loop：**
```
User → messages[] → Claude API → response
                                    │
                          stop_reason == "tool_use"?
                         yes ↓                    no ↓
                    execute tools           return text（结束）
                    append tool_result
                    loop back → messages[]
```

**QueryEngine 对外接口：AsyncGenerator\<SDKMessage\>**
```
submitMessage(prompt) → AsyncGenerator<SDKMessage>
  ├── fetchSystemPromptParts()   → 组装系统 prompt（AGENTS.md + 工具描述）
  ├── processUserInput()         → 解析 slash commands
  ├── query()                    → 主 agent loop（while true）
  │     ├── 五阶段 context 准备管道（每次 API 调用前）
  │     ├── StreamingToolExecutor → 并发/串行工具执行
  │     ├── autoCompact()         → context 压缩（触发式）
  │     └── runTools()            → 工具编排
  └── yield SDKMessage            → 流式输出（REPL 和 SDK 共用同一接口）
```

**单次 Query 数据流：**
```
processUserInput()
    ↓
fetchSystemPromptParts()   ← 静态前缀（prompt cache）+ 动态后缀（任务状态）
    ↓
recordTranscript()         ← 每次 tool call 后立即持久化到 JSONL ★ resume 基础
    ↓
normalizeMessagesForAPI()  ← context engine 入口：裁剪、压缩、格式转换
    ↓
Claude API (streaming)
    ↓
stream events → text block → yield 给消费者
             → tool_use block
                    ↓ canUseTool() 权限检查
                   DENY → 追加 error tool_result，继续 loop
                   ALLOW → tool.call() → append tool_result → loop back
```

**我们的设计决策：**
- ✅ AsyncGenerator 对外接口（REPL 和 SDK 共用）
- ✅ 每次 tool call 后立即持久化（不是 session 结束时批量写）
- ✅ `normalizeMessagesForAPI()` 作为 context engine 统一入口
- ❌ 不复制 785KB 单文件 query.ts，从第一天模块化
- ❌ 不在每次 loop 里完整重组系统 prompt，静态部分走 prompt cache

---

### 1.2 Loop State 状态机

`queryLoop()` 是 `async function*` 生成器，携带类型化 `State` 对象：

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number     // max_tokens 恢复次数（上限 3）
  hasAttemptedReactiveCompact: boolean     // ★ 防无限压缩循环的 guard
  maxOutputTokensOverride: number | undefined
  stopHookActive: boolean | undefined      // 防 stop hook 递归
  turnCount: number
  transition: Continue | undefined         // 上一次为什么继续循环（调试关键）
}
```

**transition 字段的可能值（调试信号）：**
```
'tool_use'                    — 正常工具调用
'reactive_compact_retry'      — 413 后压缩重试
'max_output_tokens_escalate'  — 8K → 64K 升级
'stop_hook_blocking'          — stop hook 强制继续
'token_budget_continuation'   — nudge 机制触发
'max_output_tokens_recovery'  — 注入 "please continue"
```

**Loop 终止条件（Terminal 枚举）：**
```
completed           — 正常完成
blocking_limit      — context 打满，需手动 /compact
model_error         — 不可恢复 API 错误
prompt_too_long     — 413 且所有恢复路径耗尽
aborted_streaming   — 用户中断
stop_hook_prevented — stop hook 永久阻止
image_error         — 图像处理错误
```

---

### 1.3 五阶段 Context 准备管道

每次 API 调用前按顺序执行，各阶段独立可组合：

```
Stage 1: Tool Result Budget（每次都运行）
  → 对聚合 tool result 按消息维度强制大小上限
  → 在 microcompact 之前运行，避免影响 cache_edits 的 tool_use_id 操作

Stage 2: Snip Compact（HISTORY_SNIP feature gate）
  → 从历史中移除旧 tool result
  → 追踪释放 token 数，反馈给 autocompact 阈值

Stage 3: Microcompact
  → 原地压缩单条大 tool result
  → cache 热时：queue cache_edits（服务端删除，不破坏 cache prefix）★
  → cache 冷时（空闲 >1h）：直接修改本地 messages[]
  → 保留最近 5 条 tool result，其余替换为 [Old tool result content cleared]

Stage 4: Context Collapse（CONTEXT_COLLAPSE feature gate）
  → REPL 全历史的 read-time 投影
  → 模型看 collapsed 视图，UI 保留完整历史（scroll 不受影响）

Stage 5: autoCompact
  → context 超过阈值时触发完整 LLM 摘要
  → 触发后立即继续 loop（post-compact messages 就绪）
```

**★ cache_edits 机制（Tier 1 压缩的核心优化）：**
```
问题：microcompact 直接修改 messages[] → 改变 prompt prefix → cache miss
      → 1.25x cache write 成本，等于付了压缩的钱却没省钱

解法：通过 API 传递 cache_edits blocks
  → 服务端按 tool_use_id 精确删除旧 tool result
  → 本地 messages[] 不变 → cache prefix 不变 → 98% cache 命中率
  → 每次 microcompact 节省约 90% input token 成本
```

---

### 1.4 三层错误恢复路径

**路径 1：413 prompt_too_long**
```
1. Collapse drain（无 LLM 调用，最便宜）
2. Reactive compact（完整 LLM 摘要）
3. 耗尽 → 返回 prompt_too_long Terminal
⚠️ 不触发 stop hooks（防 error → hook → retry → error 死循环）
```

**路径 2：max_output_tokens**
```
Stage 1 — Single-Shot Escalation：
  8K → 64K max_tokens，透明重试，模型不感知，每个 turn 只触发一次

Stage 2 — Multi-Turn Recovery（escalation 已发生或未启用时）：
  注入：「Output token limit hit. Resume directly — no apology, no recap.
         Pick up mid-thought if that is where the cut happened.」
  最多 3 次（maxOutputTokensRecoveryCount 追踪）
```

**路径 3：Schema-not-sent**
```
场景：模型试图用工具但 schema 未发送（defer_loading 导致）
恢复：Tool Search round-trip 重新注入 schema，继续 loop
```

**hasAttemptedReactiveCompact Guard（★ 必须内置，P0）：**
```
防止：compact → 还是太长 → error → stop hook → compact → ...
实现：每个 recovery path 只允许触发一次
     用 Set<string> 记录本轮已触发的 recovery 类型
历史教训：缺失这个 guard 导致 1279 个 session 各自连续失败 50+ 次，
          单个 session 最高 3272 次，浪费约 25 万次 API 调用/天
```

---

### 1.5 Loop 提前终止问题（Premature Exit）

| # | 问题 | stop_reason | 解法 | 优先级 |
|---|---|---|---|---|
| 1 | 空 tool_result | end_turn | 永远注入占位符 `"(tool_name completed with no output)"` | P0 |
| 2 | max_tokens 截断 | max_tokens | 8K→64K 升级 + "please continue" | P0 |
| 3 | 模型自认为完成 | end_turn | Stop Hooks 检测放弃信号短语 | P1 |
| 4 | Token budget 告警 | end_turn | TokenBudgetTracker nudge 机制 | P2 |

**Stop Hooks 工作机制：**
```
model 返回 end_turn
    ↓
并行执行所有匹配的 stop hooks
    ↓
exit 0  → allow stop
exit 2  → block stop，stderr 注入为 error message → loop 继续
          transition = 'stop_hook_blocking'
```
- 不在 prompt_too_long 后运行（防死循环）
- 不在用户 abort 后运行
- `stopHookActive` flag 防 stop hook 递归

**Token Budget Nudge（TokenBudgetTracker）：**
```
ContinueDecision（<90% budget）：
  nudge message 含当前百分比 → 让模型知道有余量，不要提前收尾

StopDecision（diminishing returns）：
  条件：新一轮 loop 的 token delta < 500
  含义：模型在原地转圈，主动终止防止烧钱
```

---

### 1.6 工具并发执行模型

**partitionToolCalls 分批策略：**
```
输入：[Read(f1), Read(f2), Write(f3), Read(f4), Bash(rm)]

Batch 1: [Read(f1), Read(f2)]  → 并发执行（max 10，env CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY）
Batch 2: [Write(f3)]           → 串行执行
Batch 3: [Read(f4)]            → 并发执行
Batch 4: [Bash(rm)]            → 串行执行（destructive）
```

**并发安全判断：**
- 只读工具（glob, grep, read_file, fetch）→ 并发安全
- 写入/破坏性工具（edit, write, bash with side effects）→ 串行
- 解析失败 → 保守处理，视为不安全

**StreamingToolExecutor 额外优化：**
- 模型仍在流式输出时，已开始执行已接收的 tool_use blocks
- abort 时：`getRemainingResults()` 生成合成 tool_result → 保证 messages[] 中 tool_use/tool_result 对称性

---

### 1.7 API 重试策略

```typescript
// 延迟：指数退避 + 25% jitter，上限 32 秒
// retry-after header 优先
getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000)

// 错误分类
Transient（可重试）：
  529 Overloaded  — 前台查询：3 次后切 fallback 模型；后台查询：跳过 fallback
  429 Rate limit  — 指数退避；persistent 模式下无限重试（30min 上限，30s 心跳）
  ECONNRESET/EPIPE — disableKeepAlive() 后重试

Permanent（快速失败）：
  401 — OAuth refresh 后重试一次，仍失败则清空凭据
  400 / 403 — 不重试
```

---

### 1.8 Sub-agent：三种 Spawn 模式

**模式 1：Fork（继承 prompt cache）**
```
特征：与父 agent 共享 prompt cache prefix
限制：不能选不同模型（不同模型破坏 cache key）
     Fork agent 不能再 Fork（递归保护）
适用：研究/实现类任务，中间 tool output 是一次性的
token 优势：父 agent 已缓存前缀可被复用
```

**模式 2：Fresh/Typed（独立 context）**
```
特征：完全独立的 context window，零父 agent 历史
配置：通过 subagent_type 指定
可用：Haiku 处理简单研究任务
结果：子 agent 最终消息返回父 agent（最多 100K 字符）
适用：独立分析任务，需要完整 briefing
```

**前台 vs 后台执行：**
```
前台（默认）：
  阻塞父 agent 的 turn，可随时通过 backgroundAll() 提升为后台

后台（run_in_background=true）：
  父 agent 立即收到 async_launched 状态 + agent ID + output 文件路径
  ⚠️ Escape 键取消父 turn，不取消后台 agent（需从 tasks 面板显式取消）
```

**递归限制：**
- Sub-agent 可以再 spawn sub-agent
- Fork agent 不能再 Fork
- 结果摘要：子 agent 完成后 → delta summarization（增量，不重处理全历史）

---

### 1.9 Session Resume（精确机制）

```
持久化：~/.agentx/projects/<hash>/<session-id>.jsonl
写入时机：每次 tool call 后立即写入

Resume 流程：
  1. 扫描 JSONL，找最后一个 compact boundary marker
  2. 只加载 marker 之后的消息（pre-boundary 丢弃）
  3. session-scoped permissions 不恢复（重新批准）

Fork session（--fork-session）：
  创建新 session ID，保留 history 到 fork 点，原 session 不变

中断恢复：
  工具执行中被 abort → 合成 tool_result（标记为中断）→ 可继续
```

---

### 1.10 实现优先级

| 功能 | 优先级 |
|---|---|
| AsyncGenerator 主循环骨架 | MVP P0 |
| 空 tool_result 占位符 | MVP P0 |
| hasAttemptedReactiveCompact Guard | MVP P0 |
| max_tokens 8K→64K 升级 + continue | MVP P0 |
| 每次 tool call 后立即持久化 JSONL | MVP P0 |
| 工具并发分批执行（partitionToolCalls）| MVP P0 |
| API 重试（指数退避 + 错误分类）| MVP P0 |
| Stop Hooks 基础架构（exit 0/2）| MVP P1 |
| Stop Hooks 短语检测（10 个核心短语）| MVP P1 |
| Session Resume（/resume 命令）| MVP P1 |
| Sub-agent Fresh 模式 | MVP P1 |
| Sub-agent Fork 模式 | P2 |
| 后台 sub-agent（run_in_background）| P2 |
| TokenBudgetTracker nudge | P2 |
| cache_edits（Tier 1 压缩）| P2 |
| Harness Evaluator（独立评估 agent）| P2 |

---

## 2. 基础工具

**设计原则：** 参考 FreeCode `src/tools/` 实现，最小化，不过度设计。6 个一等公民工具覆盖 coding agent 所有核心操作。

### 2.1 工具分类与并发属性

| 工具 | 并发安全 | 优先级 |
|---|---|---|
| `read_file` | ✅ | MVP P0 |
| `search`（ripgrep）| ✅ | MVP P0 |
| `create_file` | ❌ | MVP P0 |
| `edit_file`（str_replace）| ❌ | MVP P0 |
| `bash` | ❌ | MVP P0 |
| `fetch` | ✅ | MVP P0 |
| `ask_user` | ✅ | MVP P1 |

### 2.2 read_file

- **行范围：** `start_line` + `end_line`（1-indexed，包含两端）
- **大文件：** 1 GiB 硬限制（防 OOM）
- **FILE_UNCHANGED_STUB 优化：** 同一文件在 session 内被重复读取时，返回 30 词以内 stub，不重新传送完整内容（content hash 比对）
- **并发：** `isConcurrencySafe = true`

### 2.3 edit_file（str_replace）

**Must-read-first：**
- 不在工具层强制，在 prompt 层引导（系统 prompt 明确：「NEVER edit a file without reading it first」）
- 原因：有时 agent 已有文件内容（刚刚 create_file 写入），强制每次读浪费 token

**多处匹配处理：**
```
错误信息（精确设计，引导 LLM 自我修正）：
「Found X occurrences of old_str. Please provide a more specific string
 that matches only the section you want to edit.」
```

**替换失败：**
```
「old_str not found in file. Please check the exact content you want to
 replace, including whitespace and indentation.」
```

**Diff preview：** 写入前显示 before/after diff，权限对话框里可见

### 2.4 bash

**两级安全分类：**
```
Level 1 — 警告不阻止（destructiveCommandWarning.ts）：
  git reset --hard, rm -rf, DROP TABLE, kubectl delete

Level 2 — 阻止（tree-sitter AST 分析，非 regex）：
  command injection, path traversal, 危险模式组合
  ⚠️ 用 AST 不用 regex：regex 可被字符串混淆绕过
```

**输出处理：**
- stdout/stderr 超出 token 上限 → 截断 + `[output truncated]`
- 交互式命令（需 stdin）→ 系统 prompt 明确禁止，意外发生时 permission dialog 处理
- `run_in_background=true` → 返回 BashOutput（含 PID），后台 agent 基础原语

### 2.5 工具错误自愈机制

```
工具失败 → 错误注入 tool_result（不抛异常）
         → loop 继续，模型看到错误后自主决策：
           a) 换方式重试
           b) 跳过操作
           c) ask_user 请求帮助
注意：无自动重试机制，完全由模型自主决策
```

### 2.6 工具描述精简原则

**目标：** ≤100 tokens/工具（Claude Code 未优化时 550-850 tokens/工具）

```
❌ 冗余（~180 tokens）：
「Read the contents of a file at the specified path. This tool allows you to
 view file contents, useful for understanding code structure...」

✅ 精简（~40 tokens）：
「Read file contents. Supports line ranges.」
```

原则：只说「做什么」，不说「怎么做」，参数描述不加例子（例子放 prompt cache 静态前缀里）

---

## 3. 记忆管理

**来源：** FreeCode 逆向，Anthropic 官方文档，Piebald-AI system-prompts 泄漏

### 3.1 四层记忆架构（我们对应实现）

```
Layer 1：AGENTS.md            ← 静态规则，session 开始全量加载（对应 Claude Code 的 CLAUDE.md）
Layer 2：Auto Memory           ← 动态笔记，四种类型，按需加载
Layer 3：Session Memory        ← 当前 session 历史，关闭消失
Layer 4：Auto Dream            ← 后台整理 Layer 2，异步运行
```

### 3.2 Auto Memory 四种类型

| 类型 | 存什么 | 寿命 |
|---|---|---|
| `user` | 用户角色、偏好、沟通风格 | 长期稳定 |
| `feedback` | 纠正过的行为 + 验证过的做法（正负都捕获）| 中长期 |
| `project` | 项目当前状态、决策、时间约束 | 短中期，容易过时 |
| `reference` | 外部资源指针 | 中期 |

**每条记忆的文件格式：**
```yaml
---
name: feedback_no_mock_db
description: Use real database connections in tests, not mocks
type: feedback
---
Integration tests must use a real database connection...
```

**检索机制（findRelevantMemories.ts）：**
- 不是 grep，而是 Sonnet 做语义排序（扫描最多 200 个文件的 frontmatter → 发给模型 → 结构化 JSON 输出）
- 优化：最近使用的工具传给 selector → 跳过已在使用的工具参考文档

### 3.3 MEMORY.md 的精确限制

```
硬限制：200 行 OR 25KB（取先到者）

失败模式是静默的：
  超出 → 不报错、不通知模型、不通知用户
  → 模型完全不知道那些记忆存在过

我们的改进：
  接近 180 行（90% 阈值）→ 主动警告用户
  超出 200 行 → 自动触发 Dream 整理
```

### 3.4 Auto Dream 四阶段流程

**触发条件（三门锁）：**
```
距上次整理 > 24h AND 新增 session ≥ 5 AND 无 lock file
也可 /dream 手动触发
```

**四阶段：**
```
Phase 1 - Orient：
  ls 记忆目录，读 MEMORY.md，扫描 topic 文件，建立基线

Phase 2 - Gather Signal（优先级）：
  1. Daily logs（logs/YYYY/MM/DD.md）
  2. 已有记忆中与 codebase 矛盾的部分（drift detection）
  3. grep JSONL transcripts（narrow term，不全量读）

Phase 3 - Consolidation：
  - 合并重复条目（同一 quirk 记录 3 次 → 1 条）
  - 解决矛盾（保留更近的）
  - ★ 相对日期 → 绝对日期：「yesterday」→「2026-03-15」

Phase 4 - Prune & Index：
  - 删除引用了不存在文件的记忆
  - 重构 MEMORY.md，控制在 200 行以内
  - 详细内容下沉 topic 文件，索引只保留指针

安全约束：lock file 防并发整理；只写 memory 目录，不触碰项目代码
```

### 3.5 跨 Session 状态持久化（Harness 层）

来自 Anthropic Harness 工程博客，我们要内置的两个结构化文件：

**claude-progress.txt（session 进度日志）：**
```markdown
# Progress Log

## Session 2026-04-11T14:30:00Z
### Completed
- Implemented JWT token refresh (src/auth/refresh.ts)
- Fixed race condition in session store

### Current State
- Dev server on localhost:3000
- 47/200 features passing
- Last commit: "feat: jwt refresh token implementation"

### Known Issues
- Browser alert modals not visible through Puppeteer

### Next Priority
- Feature #048: User can reset password via email link
```

**feature_list.json（功能清单，防 one-shot 和过早完成）：**
```json
{
  "features": [{
    "id": "feat_001",
    "category": "functional",
    "description": "New chat button creates a fresh conversation",
    "steps": ["Navigate to main interface", "Click New Chat", "Verify new conversation"],
    "passes": false
  }]
}
```
**为什么用 JSON 不用 Markdown：** 模型对 JSON 文件更「尊重」，不会随意改写结构；Markdown 会被随意重组。Agent 只能修改 `passes` 字段。

### 3.6 实现优先级

| 功能 | 优先级 |
|---|---|
| AGENTS.md 静态加载 | MVP P0 |
| 四种 memory 类型 + MEMORY.md 索引 | MVP P1 |
| 200 行超出主动警告 | MVP P1 |
| claude-progress.txt 读写 | MVP P1 |
| feature_list.json 管理 | MVP P1 |
| Session 开始 Orientation Sequence（读 progress → 读 feature list → 冒烟测试）| MVP P1 |
| Auto Dream 手动触发（/dream）| P2 |
| Auto Dream 自动触发（三门锁）| P2 |
| Embedding 语义检索（替代 grep）| P3 |

---

## 4. 上下文管理

**来源：** FreeCode 逆向，barazany.dev compaction 分析，instructkr/claude-code 深度文档

### 4.1 AutoCompact 触发阈值

```typescript
effectiveWindow = contextWindow - max(maxOutputTokens, 20_000)
autoCompactThreshold = effectiveWindow - 13_000

// 200K 模型：
// effectiveWindow = 200K - 20K = 180K
// autoCompactThreshold = 180K - 13K = 167K（83.5% 利用率触发）

// 我们的建议（更保守）：
// 60% 触发 warm 压缩，80% 触发 cold 下沉
```

**autoCompact 不在以下 source 触发（防 deadlock）：**
- `compact`（压缩触发压缩 → 死循环）
- `session_memory`（subagent 共享 token counter）

### 4.2 三层压缩级联

**Tier 1：Microcompact（每次 loop 运行，零 LLM 调用）**
```
操作：
  - cache 热时：queue cache_edits（服务端删除，cache prefix 不变）★关键
  - cache 冷（空闲>1h）：直接修改本地 messages[]
  - 保留最近 5 条 tool result，其余替换为 [Old tool result content cleared]

效果：prompt cache 命中率 ~98%（直接修改 messages[] 只有 ~2%）
可清零的 tool 类型：file reads, shell output, grep, glob, web fetch, web search, edits, writes
```

**Tier 2：Session Memory Compact（轻量，无 LLM 调用）**
```
触发：超过 autoCompactThreshold 且 session memory file 存在
操作：用 session memory summary + 最近消息重建 context
特点：依赖 session memory 是否存在且最新
```

**Tier 3：Full Compact（最重，需 LLM 调用）**
```
触发：Tier 2 失败或不可用时
操作：fork sub-agent 做摘要（见 4.3）
Circuit Breaker：连续 3 次 Full Compact 失败 → 停止报错（不静默重试）
```

### 4.3 Full Compact 的 9-section Summary Schema

压缩时 fork sub-agent 生成结构化摘要，顺序固定：

```
1. Primary Request and Intent        ← 用户所有明确请求，详细捕获
2. Key Technical Concepts            ← 技术概念、框架、依赖
3. Files and Code Sections           ← 检查/修改的具体文件，含代码片段
4. Errors and Fixes                  ← 所有错误及修复，特别是用户反馈
5. Problem Solving                   ← 解决的问题及 troubleshooting
6. All User Messages                 ← 所有用户消息完整列表（理解意图变化）
7. Pending Tasks                     ← 被要求但未完成的任务
8. Current Work                      ← 摘要前正在做什么（verbatim 引用防漂移）
9. Optional Next Step                ← 与最近工作相关的下一步

内部推理：先写 <analysis> block → 压缩后剥离（减 token 但保留质量）
```

### 4.4 压缩后的信息恢复序列（★关键）

Full Compact 后，context 重建顺序：

```
1. Compact summary（9-section 结构化摘要）
2. 最近 5 个文件附件（≤5K tokens 每个，≤25K tokens 总）
   原因：保证 agent 有当前工作文件的完整内容
3. 活跃 skills 内容（≤25K tokens 总）
4. Plan state（如果在 /plan 模式中）
5. Tool + MCP delta attachments（新增工具 schema）
6. AGENTS.md 内容（完整）

tool_use/tool_result 对称性保证：
  Full Compact 把整个对话变成 summary，tool_use/tool_result 都消失
  新 context 从 summary 重新开始，不存在孤立的 tool_use 块

Boundary Marker：压缩完成后插入 boundary marker message
  作用：Resume 时只加载 marker 之后的内容
```

### 4.5 压缩后工具 token 处理

**Claude Code 的做法：** 压缩时继承完整工具集（为了 prompt cache 前缀一致）

**我们的改进（更激进）：**
```
压缩后重建时：
  只保留 Tier 1 工具（always-on，~2K tokens）
  Tier 2/3 工具重置为 deferred 状态

代价：压缩后第一次用 MCP 工具需一次 Tool Search 调用
收益：压缩后工具 token 从可能的几万降到 ~2K，长 session 显著更便宜
```

### 4.6 Context Reset vs Compaction（长任务）

**来自 Anthropic Harness 博客的关键结论：**
- Compaction 保留连续性，但 **context anxiety** 依然存在（模型知道快跑完了，焦虑性收尾）
- Context Reset = 完全清空 + 结构化 handoff artifact（claude-progress.txt + feature_list.json）
- **对于超过 1 个 context window 的任务：Reset 优于 Compaction**

### 4.7 我们的三层 Context Engine（hot/warm/cold）

```
HOT（当前 prompt，~8K tokens）
  ← 最近几轮 + 当前任务状态
  ← 对应 Claude Code Tier 1（microcompact 管理）

WARM（压缩历史，~2K tokens）
  ← 结构化 session summary（我们用 JSON，不用 markdown）
  ← 对应 Claude Code Tier 2（session memory compact）

COLD（磁盘存储，按需检索）
  ← JSONL transcript + sidechain files + codebase_index
  ← 我们额外加 embedding 检索（Claude Code 只有 grep）

触发边界：
  >60% context 利用率 → 触发 warm 压缩
  >80% context 利用率 → 触发 cold 下沉
```

### 4.8 实现优先级

| 功能 | 优先级 |
|---|---|
| AutoCompact 阈值计算 + 触发 | MVP P0 |
| hasAttemptedReactiveCompact Guard | MVP P0 |
| Tier 1 Microcompact（替换旧 tool result）| MVP P1 |
| Full Compact（9-section summary）| MVP P1 |
| Boundary Marker（resume 支持）| MVP P1 |
| cache_edits（prompt cache 保护）| P2 |
| Session Memory Compact（Tier 2）| P2 |
| Context Reset + Handoff Artifact | P2 |
| cold 层 embedding 检索 | P3 |

---

## 5. 工具管理与 Tool Registry

**来源：** Claude Code Issues #11364，Anthropic 工程博客 advanced-tool-use，实测数据

### 5.1 问题规模（实测数据）

| 场景 | 工具 token 消耗 | 占 200K 窗口 |
|---|---|---|
| 4 个 MCP server（67 tools）| ~66K tokens | 33% |
| 7 个 MCP server | ~82K tokens | 41% |
| GitHub MCP（27 tools）| ~18K tokens | 9% |
| MCP_DOCKER（135 tools）| ~126K tokens | 63% |

**每条工具描述成本：**
- 未优化（完整 JSON schema）：550-850 tokens/工具
- 优化后（name + 一行描述）：50-100 tokens/工具
- 节省幅度：85-90%

**工具太多 → 模型变蠢：** Tool Search 使 Opus 4 在 MCP eval：49% → 74%（工具选择准确率）

### 5.2 三层工具分级

```
┌─────────────────────────────────────────────────────┐
│  Tier 1：Always-On（始终在 context，~2K tokens）     │
│  - 6 个内置核心工具                                  │
│  - 每个工具描述 ≤100 tokens                          │
│  - 不可 defer，agent 随时可能需要                    │
├─────────────────────────────────────────────────────┤
│  Tier 2：Session-Scoped（按需预加载）                │
│  - 根据 AGENTS.md 或任务类型预判                     │
│  - 用过一次后 session 内缓存                         │
│  - 例：git 任务 → 预加载 git MCP                    │
├─────────────────────────────────────────────────────┤
│  Tier 3：On-Demand（用到时才加载）                   │
│  - 所有其他 MCP 工具                                 │
│  - 通过 Tool Search 按需发现                         │
│  - 加载后进入 Tier 2 缓存                            │
└─────────────────────────────────────────────────────┘
```

### 5.3 Tool Search 工作机制

**触发阈值：** MCP 工具描述 >10K tokens 自动启用

**defer_loading 机制：**
```
初始 context：
  Tier 1 工具（全量）+ Tool Search Tool + 所有 deferred 工具（name + 1行描述）

Claude 需要某工具时：
  → 调用 Tool Search（语义模式或 Regex 模式）
  → 加载 3-5 个相关工具的完整 schema（~3K tokens）
  → 该工具加入 session 内 Tier 2 缓存

效果：195K tokens 可用 vs 原来 92K tokens（~95% 减少）
```

**Task-Phase Tool Scoping（Vercel 验证有效）：**
```typescript
const PHASE_TOOLS = {
  research: ['read_file', 'search', 'fetch'],        // 只读
  plan:     ['read_file', 'search', 'ask_user'],     // 只读 + 交互
  execute:  ['read_file', 'edit_file', 'create_file', 'bash'],  // 读写
  verify:   ['bash', 'read_file', 'fetch'],          // 执行 + 只读
}
```

### 5.4 Tool Registry 架构

```typescript
interface SkillRecord { ... }  // 见方向 6

interface ToolRecord {
  name: string
  description: string          // ≤100 tokens
  schema: JSONSchema
  tier: 1 | 2 | 3
  concurrencySafe: boolean
  source: 'builtin' | 'mcp' | 'extension'
  tokenCost: number            // 运行时统计
  loaded: boolean              // 当前是否在 context 中
}

// 注册
registry.registerBuiltin([...])                    // Tier 1，永远加载
registry.registerMCP(server, { deferLoading: true, preloadTriggers: ['git'] })
registry.registerExtension(toolDef, { tier: 2 | 3 })

// Registry 职责
// - 维护三层状态（loaded / deferred / unknown）
// - 生成精简工具索引（用于 Tool Search）
// - 追踪每个工具的 token 成本
// - session 结束时输出工具使用统计
```

### 5.5 实现优先级

| 功能 | 优先级 |
|---|---|
| Tier 1 工具注册（精简描述 ≤100 tokens）| MVP P0 |
| Tool Registry 基础架构 | MVP P0 |
| MCP defer_loading 支持 | MVP P1 |
| Tool Search Tool 实现 | MVP P1 |
| Session 内工具缓存 | MVP P1 |
| Task-Phase Tool Scoping | P2 |
| 工具 token 成本追踪 | P2 |
| 压缩后工具重置（Tier 2/3 → deferred）| P2 |

---

## 6. Skill 系统

**标准：** 遵循 agentskills.io 开放标准（Anthropic 主导，Claude Code/OpenCode/Gemini CLI 共同采纳）
**立场：** 提供可靠基建，不控制第三方 skill 质量，但对 token 消耗有兜底硬限制

### 6.1 Skill 目录结构（agentskills.io 标准）

```
skill-name/
├── SKILL.md          ← 必须：元数据 + 指令
├── scripts/          ← 可选：可执行代码（执行输出进 context，脚本本身不进）
├── references/       ← 可选：参考文档（按需读取，不读不消耗 token）
└── assets/           ← 可选：模板、静态资源
```

### 6.2 SKILL.md Frontmatter Schema

```yaml
---
name: pdf-processing          # 必须，≤64字符，小写字母/数字/连字符，匹配目录名
description: |                # 必须，≤1024字符，描述能力 + 触发场景
  Extract PDF text, fill forms, merge files.
  Use when handling PDFs or when user mentions PDFs, forms, or document extraction.
license: Apache-2.0           # 可选
compatibility: Requires Python 3.12+ and pdfplumber  # 可选，≤500字符
metadata:                     # 可选，任意 key-value
  author: example-org
  version: "1.0"
allowed-tools: Bash(python:*) Read  # 可选，空格分隔（实验性）
---
```

**description 字段是 skill 触发的唯一依据。** 写法模板：「[能力描述]. Use when [触发场景].」

### 6.3 三层 Progressive Disclosure

| 层级 | 内容 | 时机 | Token 成本 |
|---|---|---|---|
| Tier 1：Catalog | name + description | Session 开始 | ~50-100 tokens/skill |
| Tier 2：Instructions | SKILL.md 完整主体 | skill 被激活时 | <5000 tokens（推荐上限）|
| Tier 3：Resources | scripts/references/assets | 指令引用时 | 按需 |

**重要 Bug（issue #14882）：** Claude Code 宣称 progressive disclosure，但 `/context` 显示 skill 全量 token 在启动时消耗。我们从源头解决：SKILL.md 主体强制 ≤500 行，详细内容放 references/ 按需读取。

### 6.4 Skill 发现（Discovery）

**扫描路径（优先级从高到低）：**
```
Project 级（可 override User 级同名 skill）：
  <project>/.agentx/skills/          ← 我们的原生路径
  <project>/.agents/skills/          ← 跨客户端互操作（agentskills.io 标准）
  <project>/.claude/skills/          ← 兼容已有 Claude Code skill

User 级：
  ~/.agentx/skills/
  ~/.agents/skills/
  ~/.claude/skills/

Built-in（随 agent 分发）：
  <install-dir>/skills/
```

**扫描规则：**
```
在每个路径下查找：包含 SKILL.md 的子目录
跳过：.git/, node_modules/, build/, dist/
边界：最大深度 4 层，最多 2000 个目录
Name collision：项目级 > 用户级 > 内置（同级 first-found，warn）
信任检查：项目级 skill 只在用户确认信任该项目后加载（防恶意 repo 注入指令）
```

### 6.5 Skill 解析（Parsing）

**YAML 容错处理（关键，第三方 skill 常见问题）：**
```
常见问题：description: Use this when: user asks about PDFs
          ↑ 冒号导致 YAML 解析失败

解决：
  1. 标准 YAML 解析
  2. 失败时自动检测「key: value with: colon」→ 转 block scalar → 重试
  3. 仍失败 → skip + warn（记录诊断）
```

**宽松验证策略：**
```
name 不匹配目录名     → warn，继续加载
name 超过 64 字符     → warn，继续加载
description 为空      → skip + error（必须有 description）
YAML 完全无法解析     → skip + error
```

**存储结构：**
```typescript
interface SkillRecord {
  name: string
  description: string
  location: string          // SKILL.md 绝对路径
  baseDir: string           // 父目录（解析相对路径用）
  tier: 'project' | 'user' | 'builtin'
  disabled: boolean
  bodyTokenEstimate?: number
}
```

### 6.6 Skill 披露（Disclosure）

**注入 system prompt 的 catalog 格式：**
```xml
<available_skills>
  <skill>
    <n>pdf-processing</n>
    <description>Extract PDF text, fill forms, merge files. Use when handling PDFs.</description>
    <location>/home/user/.agents/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>

When a task matches a skill's description, use your read_file tool to load
the SKILL.md at the listed location. Resolve relative paths against the
skill's directory (parent of SKILL.md).
```

**不进 catalog 的情况：**
- `disable-model-invocation: true` 的 skill（完全隐藏）
- 用户禁用的 skill
- 未通过信任检查的项目级 skill
- **无 skill 时：不显示空块**（会困惑模型）

### 6.7 Skill 激活（Activation）

**路径 1：File-read 激活（默认，最简单）**
```
模型读 catalog → 决定 skill 相关 → 调用 read_file(SKILL.md 路径)
→ SKILL.md 完整内容进入 context
→ 模型按指令执行，自主读取 references/ 或 scripts/
```

**路径 2：activate_skill 专用工具（推荐用于生产）**
```typescript
// name 参数用 enum 约束（防幻觉）
{
  name: "activate_skill",
  parameters: {
    name: { enum: [...已发现的 skill 名称列表] }
  }
}

// 返回
{
  content: "<skill>\n...(frontmatter stripped, body only)...</skill>",
  base_dir: "/path/to/skill/",
  resources: ["references/api.md", "scripts/process.py"]  // 可用资源列表
}
```
优势：控制内容（strip frontmatter）、包裹 `<skill>` tag（便于 compaction 识别和重附加）、枚举约束防幻觉、可统计激活次数

**用户显式激活（/skill-name）：**
```
用户输入 /pdf-processing → harness 拦截 → 直接注入 SKILL.md 内容
提供 tab 自动补全（列出可用 skill）
```

### 6.8 Token 兜底机制（不依赖 skill 作者自律）

```
Catalog 总量（所有 skill 的 name + description）：
  软上限：15K characters（~4K tokens）
  超出：按 tier 优先级截断（builtin > project > user），warn 用户

单个 SKILL.md 主体：
  软上限：5000 tokens（推荐，对作者是建议）
  硬上限：10000 tokens（超出截断 + warn，不报错不中断）
  原因：不能让一个写得很长的第三方 skill 破坏整个 session

所有已激活 skill 的总预算（compaction 后重附加）：
  每个 skill 前 5000 tokens，总共 25K tokens
  超出：按激活时间截断（最近的优先）

session 内去重：
  维护 activatedSkills: Set<string>
  同名 skill 同一 session 只注入一次
```

### 6.9 管理命令体系

```bash
# 查看
/skills                        # 列出所有 skill + token 消耗（实际消耗，非估算）
/skills --verbose              # 详细信息（来源、激活历史）

# 本地安装
/skill install /path/to/skill-dir/
/skill install /path/to/skill-dir/ --project

# 从 GitHub 安装
/skill install owner/repo
/skill install owner/repo/skill-name

# 卸载与控制
/skill uninstall pdf-processing
/skill disable pdf-processing   # 当前 session 禁用
/skill enable pdf-processing

# 诊断
/skill validate /path/to/skill-dir/  # 运行 agentskills.io 标准验证
```

### 6.10 实现优先级

| 功能 | 优先级 |
|---|---|
| SKILL.md 解析（含容错 YAML）| MVP P0 |
| Skill 发现（多路径扫描）| MVP P0 |
| Catalog 生成（注入 system prompt）| MVP P0 |
| File-read 激活 | MVP P0 |
| 用户显式激活（/skill-name + tab 补全）| MVP P0 |
| Session 内去重 | MVP P1 |
| activate_skill 专用工具 | MVP P1 |
| Token 硬上限（单 skill + 总预算）| MVP P1 |
| 信任检查（项目级 skill）| MVP P1 |
| /skills 命令（token 透明度）| MVP P1 |
| Compaction 后重附加（<skill> tag）| P2 |
| /skill install（从 GitHub）| P2 |
| agentskills-ref 验证集成 | P2 |

---

## 7. Codebase Index（新 Session 冷启动）

**核心问题：** 新开 session 时 agent 不知道项目结构，需重新扫描，浪费 token 和时间。

### 7.1 冷启动问题对比

**无索引（Claude Code 现状）：**
```
用户：「帮我修改认证模块的 token refresh 逻辑」
→ search("token refresh") → 读 3-5 候选文件 → grep → 定位
浪费：~2000-5000 tokens + 10-30 秒
```

**有 codebase_index（我们）：**
```
session 开始自动注入 codebase_index.md（~400 tokens）
用户：「帮我修改认证模块的 token refresh 逻辑」
→ 已知 src/auth/refresh.ts 是热区，JWT + redis，禁 mock DB
→ 直接 read_file(src/auth/refresh.ts)
→ 跳过探索阶段
```

### 7.2 两层索引架构

**Layer 1：结构索引（Structural Index）— MVP P0，零依赖**

纯文本 `codebase_index.md`，session 开始自动注入 system prompt：

```markdown
# Codebase Index
updated: 2026-04-11T14:30:00Z
git_hash: a3f4c2d

## Module Map
src/auth/     → JWT + session，依赖 redis，入口 src/auth/index.ts
src/api/      → Express router，版本前缀 /v1/，~40 个 endpoint
src/db/       → Prisma ORM，PostgreSQL
src/utils/    → 通用工具，无外部依赖

## Key Files
src/index.ts       → 主入口，启动顺序：db → redis → express
config/app.ts      → 环境变量（zod 验证）

## Recent Hot Zone
src/auth/refresh.ts      ← last session 主要修改文件
src/api/users.ts         ← 有未解决 TODO: rate limiting

## Build & Run
dev:   pnpm dev
test:  pnpm test（jest --runInBand，禁止 mock DB）
build: pnpm build

## Architecture Constraints
依赖方向：types → config → db → service → api
```

**token 成本：~300-500 tokens**

**Layer 2：语义索引（Semantic Index）— P2，可选**
```
Tree-sitter 解析 → 函数/类级别 chunking → 本地嵌入 → SQLite-vec（零外部依赖）

优势：按语义搜索（「找认证中间件」而非精确字符串匹配）
存储：.agentx/index.db（可 .gitignore）
增量更新：按 content hash 判断变更（Cursor 方案），只重新 embed 变化文件
```

### 7.3 更新时机

```
PostToolUse(edit_file/create_file)：
  → 标记文件为 dirty，异步更新 Layer 1 对应条目

Stop hook（session 结束）：
  → 批量更新 dirty 文件的 Layer 2 向量
  → 更新 Recent Hot Zone

PreCompact hook（压缩前）：
  → 检查 codebase_index.md 是否需要更新
  → 先更新索引再压缩，确保摘要里文件路径准确

/index 命令（手动）：
  → 全量重建
```

### 7.4 内置 codebase-orientation Skill

新 session 快速上下文的 skill：

```yaml
---
name: codebase-orientation
description: Get oriented in a new codebase or after context reset. Use at session
  start or when unfamiliar with the project structure.
---
# Codebase Orientation

1. Read codebase_index.md (or .agentx/codebase_index.md)
2. Run `git log --oneline -10` to see recent changes
3. Run init.sh if it exists (start dev server)
4. Run smoke test to verify basic functionality
5. Report: module map, hot zones, known issues
```

### 7.5 实现优先级

| 功能 | 优先级 |
|---|---|
| Layer 1 结构索引（codebase_index.md）| MVP P0 |
| PostToolUse hook 触发更新 | MVP P1 |
| /index 手动重建命令 | MVP P1 |
| codebase-orientation 内置 skill | MVP P1 |
| Layer 2 Tree-sitter 语义索引 | P2 |
| SQLite-vec 本地向量存储 | P2 |
| 增量更新（hash diff）| P2 |

---

## 8. Hook 系统

**本质：** 在 agent 生命周期特定节点强制执行确定性 shell 命令，不依赖模型「记得」去做。这是 AGENTS.md 指令（建议）和 hook（保证）的根本区别。

### 8.1 核心事件与能力矩阵

| 事件 | 能拦截 | 能修改输入 | exit 2 效果 |
|---|---|---|---|
| `PreToolUse` | ✅ | ✅（v2.0.10+）| block tool call |
| `PostToolUse` | ❌ | ❌ | error → Claude |
| `PermissionRequest` | ✅ | ❌ | deny permission |
| `Stop` | ✅ | ❌ | force continue |
| `SubagentStop` | ✅ | ❌ | force continue |
| `PreCompact` | ✅ | ❌ | 干预压缩 |
| `SessionStart` | ❌ | ❌ | inject context |
| `SessionEnd` | ❌ | ❌ | 清理/日志 |
| `UserPromptSubmit` | ❌ | ✅ | inject context |

**exit code 语义：**
```
0        → 正常通过
2        → 拦截（PreToolUse/Stop/PermissionRequest）
           stderr 内容传给 Claude 作为错误上下文
其他非 0 → 非拦截性错误，显示给用户
```

**Hook 的四种类型：**
- `command`：shell 命令（最常用）
- `http`：POST 事件数据到 URL
- `prompt`：调用轻量模型（Haiku）做语义评估
- `agent`：spawn 子 agent，有工具访问权限（最重）

**PreToolUse 输入修改（关键特性）：**
```
hook 可修改工具参数 JSON，执行使用修改后的参数（对 Claude 不可见）
用途：自动注入 --dry-run、路径规范化、secret 脱敏
⚠️ 并行时最后完成的 hook 的修改生效（不确定顺序）
   → 同一工具不要有多个修改 hook
```

### 8.2 内置 Default Hooks（开箱即用）

用户不需手动配置，我们内置：

| Hook | 事件 | 触发条件 | 行为 |
|---|---|---|---|
| 危险命令拦截 | PreToolUse | `Bash(rm -rf\|git reset --hard\|DROP TABLE)` | exit 2 阻止 |
| 空 tool_result 保护 | PostToolUse | 所有工具 | 确保 result 永不为空 |
| codebase_index 更新 | PostToolUse | `Edit\|Write` + 模块文件 | 标记 dirty，异步更新 |
| 文档变更检测 | PostToolUse | `Edit\|Write` + 接口文件 | 标记待检查队列 |
| 文档同步判断 | Stop | session 结束 | Haiku 判断是否需要更新文档 |
| PreCompact 索引刷新 | PreCompact | 触发压缩时 | 先刷新索引再压缩 |

用户可通过 `.agentx/hooks.json` 覆盖或禁用任何内置 hook。

### 8.3 文档自动同步设计

**触发层（确定性，hook 做）：**
```bash
# PostToolUse hook：检测接口文件变更
file_path=$(echo "$STDIN" | jq -r '.tool_input.file_path // empty')
if is_api_file "$file_path"; then
  echo "$file_path" >> ~/.agentx/pending-doc-check.txt
fi
```

**判断层（语义，Haiku 做）：**
```json
{
  "hooks": {
    "Stop": [{
      "type": "prompt",
      "model": "claude-haiku-4-5",
      "prompt": "Did any of these modified files affect public APIs? $PENDING_FILES
                 If yes: NEEDS_DOC_UPDATE:<file1>,<file2>
                 If no:  NO_UPDATE_NEEDED"
    }]
  }
}
```
**每次 session 结束仅一次 Haiku 调用，成本极低（~500 tokens）。**

### 8.4 实现优先级

| 功能 | 优先级 |
|---|---|
| Hook 事件总线 + command 执行 | MVP P0 |
| 危险命令拦截（PreToolUse）| MVP P0 |
| 空 tool_result 保护（PostToolUse）| MVP P0 |
| codebase_index 更新（PostToolUse）| MVP P1 |
| Hook 配置文件（.agentx/hooks.json）| MVP P1 |
| prompt 类型 hook（Haiku 调用）| P2 |
| 文档变更检测 + 同步判断 | P2 |
| PreCompact 索引刷新 | P2 |
| http 类型 hook | P3 |
| agent 类型 hook | P3 |

---

## 9. Harness 思想与各方向补强

**来源：** Anthropic Engineering Blog（Nov 2025 / Apr 2026），OpenAI Harness Engineering（Feb 2026）

### 9.1 核心定义与类比

> **「The model is commodity. The harness is moat.」**

```
模型      = CPU
上下文窗口 = RAM
Harness   = 操作系统
Agent     = 应用程序
```

Harness 是包裹模型的全部非模型基础设施：工具分发、context 管理、权限控制、错误恢复、状态持久化。

**行业共识（2026）：** 代理的失败几乎全是 harness 失败，不是模型失败。

### 9.2 Anthropic 两篇 Harness 论文核心发现

**论文一（Nov 2025）：Effective Harnesses for Long-Running Agents**

两大失败模式：
1. **One-shot 倾向**：agent 试图一次性完成所有任务 → context 一半崩掉
2. **过早宣告完成**：后期 session 看到已有进展就认为工作完成了

两部分解法：
```
Initializer Agent（第一个 session）：
  写 init.sh（启动开发服务器）
  写 claude-progress.txt（进度日志）
  写 feature_list.json（功能清单，全部 passes: false）
  初始 git commit（建立基线）

Coding Agent（后续每个 session）：
  读 progress.txt + git log + feature_list.json → 了解现状
  一次只做一个 feature
  Browser automation 做端到端测试（不是 unit test）
  写 git commit + 更新 progress.txt
```

**论文二（Apr 2026）：Harness Design for Long-Running Apps**

三 Agent 架构：
```
Planner   → 把 spec 分解成离散的 chunk
Generator → 在单个 context window 内实现一个 chunk
Evaluator → 独立 agent，用预定义标准评分（物理隔离！）
```

**自我评估偏差（Self-Evaluation Bias）：** 让写代码的 agent 评估自己的代码 → 掩盖 bug 给自己打高分。必须用物理隔离的独立 Evaluator。

**Context Reset vs Compaction：** 对超过 1 个 context window 的任务，**Reset + Handoff artifact 优于 Compaction**（compaction 保留了 context anxiety）。

### 9.3 OpenAI Harness Engineering（Feb 2026）

实验规模：3→7 人，5 个月，100 万行代码，1500 个 PR，零人工代码

三大支柱：
```
1. Context Engineering：
   Repository = single source of truth
   轻量引用（文件路径）+ 按需加载，不预加载所有内容

2. Architectural Constraints（机械约束）：
   Types → Config → Repo → Service → Runtime → UI
   用自定义 linter + 结构测试强制执行
   linter 报错 → 错误注入 context → agent 自己修复

3. Entropy Management：
   定期运行 refactor agent
   AGENTS.md 是 living document（agent 遇到新问题时更新）
   把一次性手动修复转化为永久约束（新 lint rule）
```

### 9.4 Harness 六大核心原则

```
原则 1：机械约束 > 文档约束
  linter/hook/schema 里的规则 agent 无法绕过
  AGENTS.md 里的规则 agent 可能忘记

原则 2：结构化 Artifact > 对话 History
  跨 session：JSON feature list + progress file + git log
  不依赖 compaction 摘要（会丢失结构）

原则 3：独立评估 > 自我评估
  Evaluator 必须物理隔离，独立 context 和 prompt

原则 4：增量进度 > 一次性完成
  一次只做一个 feature，完成后 commit + 更新 progress

原则 5：环境告诉 agent 什么是错的
  linter 报错 → 注入 context → agent 自己修复

原则 6：Context 利用率有甜点（~40%）
  超过 40% 性能开始下降，超过 70% 显著恶化
```

### 9.5 各方向补强映射

| 方向 | 现有设计 | Harness 补强 |
|---|---|---|
| 主循环 | Stop hooks 短语检测 | 升级为独立 Evaluator judge（cheap model）|
| 主循环 | 最大步数限制 | Progress Checkpoint：每 N 步强制写入快照 |
| 主循环 | ReAct loop | Verification Loop：tool call 后检查输出 schema |
| 工具 | bash 危险命令检测 | Linter as Hook：自定义 lint 规则进 PreToolUse |
| 记忆 | codebase_index.md | 升级为完整 Environment State File |
| 记忆 | session 开始读索引 | 硬编码 Orientation Sequence（读 progress → 冒烟测试）|
| 上下文 | hot/warm/cold 三层 | Context Budget Guard：>40% soft warn，>70% 强制 compact |
| 上下文 | compaction 策略 | 长任务改用 Context Reset + Handoff Artifact |
| Hook | 文档检测 | session 结束时运行 Architecture Linter |
| Hook | 内置 hooks | Entropy Hook：每 N 个 session 触发 refactor agent |
| 工具管理 | 三层分级 | Task-Phase Tool Scoping（四个阶段各有工具集）|

### 9.6 Harness 层文件结构

```
src/harness/
├── initializer.ts       ← 第一个 session 的特殊 prompt + 环境搭建
├── session-start.ts     ← Orientation sequence（硬编码）
├── progress-tracker.ts  ← claude-progress.txt 读写
├── feature-list.ts      ← feature_list.json 管理（JSON 格式）
├── evaluator.ts         ← 独立 Evaluator agent
├── verification.ts      ← tool call 输出 schema 验证
├── linter-bridge.ts     ← linter 错误注入 agent context
└── entropy-manager.ts   ← 定期 refactor agent 触发
```

### 9.7 实现优先级

| 组件 | 优先级 |
|---|---|
| progress-tracker | MVP P0 |
| session-start Orientation（硬编码步骤）| MVP P0 |
| verification（基础 schema 验证）| MVP P1 |
| feature-list（JSON 格式）| MVP P1 |
| evaluator（独立 judge agent）| P2 |
| linter-bridge | P2 |
| entropy-manager | P3 |

---

## 10. CLI 渲染

**策略：全盘照抄 FreeCode，不做额外设计。**

参考来源：
- `src/screens/REPL.tsx` — 主交互界面（Ink/React）
- `src/components/` — 所有终端 UI 组件
- `src/hooks/` — React hooks

直接对照 FreeCode 源码移植，不重新设计。

---

## 11. 附录：资源索引

| 资源 | URL | 用途 |
|---|---|---|
| FreeCode | github.com/paoloanzn/free-code | Claude Code 可编译 fork，去除遥测，主要参考 |
| learn-coding-agent | github.com/sanbuphy/learn-coding-agent | 逆向分析，12 层 harness 机制文档 |
| instructkr/claude-code | zread.ai/instructkr/claude-code | query.ts 深度解析，tool execution 分析 |
| Victor Dibia newsletter | newsletter.victordibia.com | compaction、circuit breaker、stop hooks 细节 |
| barazany.dev compaction | barazany.dev/blog/claude-codes-compaction-engine | Three-tier compaction + cache_edits 分析 |
| Anthropic Harness Blog（Nov 2025）| anthropic.com/engineering/effective-harnesses-for-long-running-agents | Initializer/Coding agent 模式 |
| Anthropic Harness Blog（Apr 2026）| anthropic.com/engineering/harness-design-long-running-apps | Three-agent 架构，Context Reset |
| OpenAI Harness Engineering | openai.com/index/harness-engineering | 100 万行代码实验，Architectural Constraints |
| Anthropic Tool Use 工程博客 | anthropic.com/engineering/advanced-tool-use | Tool Search + defer_loading 官方原理 |
| agentskills.io | agentskills.io/specification | Skill 开放标准（规范 + Client 实现指南）|
| Claude Code Issues #42796 | github.com/anthropics/claude-code | premature exit 实证数据（173 次触发）|
| Claude Code Issues #11364 | github.com/anthropics/claude-code | MCP tool lazy loading 详细分析 |
| Claude Code Issues #14882 | github.com/anthropics/claude-code | skill progressive disclosure bug |
| Roo Code Codebase Indexing | docs.roocode.com/features/codebase-indexing | Tree-sitter + Qdrant 实现参考 |
| Piebald-AI system-prompts | github.com/Piebald-AI/claude-code-system-prompts | Dream 整理完整 system prompt |
| Claude Code 官方文档 | code.claude.com/docs | resume、subagent、hooks、compaction 官方说明 |

---

*文档版本：v3（合并版）*
*生成日期：2026-04-11*
*状态：可直接用于技术设计*
