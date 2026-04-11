# Merlion 初步方案评审（2026-04-11）

## 结论先行

`initial_design.md` 的方向整体是对的，尤其是这几条判断：

- 以 harness/context/tooling 为核心，而不是把希望寄托在模型“自己变聪明”
- 工具按需加载、skill 渐进披露、结构化持久化、模块化 runtime
- 把质量问题拆成循环控制、验证、权限、安全、状态管理几个层面

但文档当前有两个明显问题：

1. **把很多“从泄漏源码/逆向里看到的机制”直接上升成产品架构**，证据强弱没有分层。
2. **为了省 token 引入了过多次级系统**，其中几项本身就会额外耗 token、耗实现复杂度、耗维护心智。

如果 Merlion 的核心目标是“质量对标 Claude Code / Codex，同时尽可能省 token”，我给的总体判断是：

- **战略正确**
- **战术偏重**
- **MVP 范围过大**

更好的路线不是“做得更多”，而是：

- 用最少的常驻上下文
- 用最强的确定性反馈
- 只在模型真的不够时再加 harness 组件

这也和 Anthropic 在 2026-03-24 的文章里强调的方向一致：**先找最简单可行解，再按需要增加复杂度**。  
来源：<https://www.anthropic.com/engineering/harness-design-long-running-apps>

## 一、哪些设计是可行且值得保留的

### 1. 主循环骨架

`initial_design.md:25-79` 的最小 ReAct loop、`AsyncGenerator` 对外接口、tool_result 持久化、`normalizeMessagesForAPI()` 统一入口，这些都合理，建议保留。

原因：

- `free-code` 和 `claw-code` 都证明了 CLI coding agent 的核心仍然是 “streaming model loop + tool execution + session persistence”
- `claw-code` 当前公开结构已经把 runtime / tools / commands / plugins 拆开，而不是继续堆单个超大文件

参考：

- `claw-code` workspace 结构：runtime、tools、commands、plugins 分层  
  <https://github.com/ultraworkers/claw-code>
- `free-code` README 明确它是基于 2026-03-31 暴露快照的可构建 fork  
  <https://gitlawb.com/node/repos/z6MkgKkb/paoloanzn-free-code>

### 2. 工具按需加载与精简描述

`initial_design.md:731-839` 这一章总体是对的，而且和 Anthropic 官方 2025-11-24 的 advanced tool use 直接一致。

应该保留：

- Tier 1 少量内置核心工具
- MCP / 扩展工具 defer loading
- Tool Search
- 工具描述尽量短

官方依据：

- Anthropic 明确说，工具定义和结果可能在真正处理用户请求前就消耗 `50,000+` tokens
- 官方新能力的目标就是“不要把所有工具定义提前塞进上下文”

来源：<https://www.anthropic.com/engineering/advanced-tool-use>

### 3. Skill 的渐进披露

`initial_design.md:842-1065` 基本成立，而且和 Agent Skills 官方规范一致。

应保留：

- startup 只注入 `name + description`
- 激活后再读 `SKILL.md`
- `references/`、`scripts/` 按需读取
- 对 skill token 做硬预算

官方规范明确建议：

- metadata 常驻
- `SKILL.md` 主体激活时再载入
- 主文件控制在 `< 5000 tokens` 推荐范围、`500 lines` 左右

来源：<https://agentskills.io/specification>

### 4. 结构化跨 session artifact

`initial_design.md:531-582` 和 `1286-1426` 里关于 progress file / feature list / orientation sequence 的思路是成立的。

Anthropic 2025-11-26 的官方文章明确验证了：

- initializer agent
- 进度日志
- feature list
- 一次只做一个 feature

这些对抑制 one-shot 和“过早宣布完成”有效。  
来源：<https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>

### 5. 短 AGENTS + 仓库内文档才是 source of truth

这里你的文档其实还不够激进。

OpenAI 在 2026-02-11 的 Harness Engineering 里说得很清楚：

- `AGENTS.md` 不应该是百科全书，而应该是 table of contents
- repository-local docs 才应该是 system of record

这对省 token 很关键，因为它天然反对“大一统超长系统提示词”。

来源：<https://openai.com/index/harness-engineering/>

## 二、哪些地方过度设计、证据不足，或者现在不该做

### 1. `cache_edits`、`98% cache hit`、`90% token savings` 这类数字不应进入架构承诺

对应：

- `initial_design.md:152-160`
- `initial_design.md:610-619`

问题：

- 这些机制主要来自逆向和二手分析，不是公开稳定接口
- 数字过于具体，但缺少可复现实验条件
- 一旦上游 API、prompt cache key、tool block 格式变动，设计就会失效

建议：

- **不要把 `cache_edits` 作为 P2 架构前提**
- 先做本地可控的 `tool_result budget + truncation + summary pointer`
- 只有在真实 trace 证明“prompt cache miss 是成本主因”后，再专项优化

### 2. Full Compact 的 9-section schema 太重，尤其是 `All User Messages`

对应：`initial_design.md:635-671`

问题：

- “All User Messages 完整列表”本身就在和省 token 目标对冲
- 9 段 schema 过于静态，容易让摘要为了满足格式而保留低价值内容
- 让压缩 sub-agent 先写 `<analysis>` 再剥离，也会增加实现复杂度

建议：

- 压缩 schema 收缩为 4 块：
  - current objective
  - verified facts / current state
  - pending work
  - high-value attachments pointers
- 绝不要求“保留全部用户消息”
- 以“后续 agent 是否能继续工作”为判定标准，不以“摘要看起来完整”为标准

### 3. Auto Dream / 四层记忆现在过早

对应：`initial_design.md:454-528`

问题：

- 这套系统更像长期个人助理，而不是先把 coding agent 做强
- 语义选记忆如果靠 Sonnet 排序，本身就要持续花 token
- 过早引入长期记忆，很容易把过期信息重新注入高优先级上下文

建议：

- MVP 只保留三类持久信息：
  - `AGENTS.md` / docs 索引
  - progress artifact
  - session transcript / compact summary
- 长期 memory 先不要自动写，只保留手动 pin
- `Auto Dream` 延后到产品已经验证“长期用户偏好记忆”真有价值再做

### 4. 默认假设“长任务 = reset 优于 compaction”已经过时

对应：`initial_design.md:688-693`、`1337-1339`

这在 Anthropic 2025-11-26 的 harness 文章里成立，但到了 2026-03-24 的新文章，结论已经变了：

- Sonnet 4.5 上，context reset 很关键
- 但在后续 harness 中，Anthropic 因为模型能力提升，直接改成 **continuous session + automatic compaction**
- 他们还明确在删减不再 load-bearing 的 scaffold

所以这里不能写成固定原则，只能写成：

- **model-dependent fallback strategy**

建议：

- 默认：continuous session + compaction
- 触发 hard reset 的条件化策略：
  - context coherence 下降
  - 连续 compact 后质量恶化
  - 任务天然跨多阶段且 artifact 已齐

### 5. Sub-agent 体系现在写得太细，超过了当前阶段需要

对应：`initial_design.md:281-315`

问题：

- fork / fresh / background / recursive limit / delta summarization 一次性上太多
- 真正提升质量的不是“子 agent 种类多”，而是“什么时候需要隔离评估”

Anthropic 2026-03-24 的经验更接近：

- 保留 planner
- 保留 evaluator
- 把不再必要的 sprint 结构删掉

建议：

- MVP 只保留两类：
  - `worker`：独立执行子任务
  - `reviewer/evaluator`：独立质量评估
- `fork with shared prompt cache` 不进 MVP
- 后台 agent 不是质量核心，延后

### 6. Hook 类型过多，且把语义判断塞进 hook 容易失控

对应：`initial_design.md:1191-1282`

问题：

- `command/http/prompt/agent` 四类 hook 同时存在，会迅速形成一个“第二运行时”
- 一旦 hook 里还会调用模型，你需要再处理费用、超时、可观测性、失败恢复

建议：

- MVP 只做 deterministic hooks：
  - pre-tool permission/sandbox
  - post-tool file dirty mark
  - session start / end artifact sync
- 语义类 hook 暂时移到显式 verifier 阶段，不要藏在 hook 系统里

### 7. `codebase_index.md` 可以做，但别把它神化成冷启动银弹

对应：`initial_design.md:1069-1183`

可行，但要小心两个问题：

- 结构索引很快过时
- 语义索引引入额外维护复杂度和本地依赖

OpenAI 更像是把 repo 文档做成 source of truth，而不是依赖一个单独的“项目索引文件”。

建议：

- 保留一个很小的 `codebase_index.md`
- 但真正的信息源放在 repo docs、architecture docs、exec plans
- embedding / SQLite-vec 先不做

### 8. “CLI 渲染全盘照抄 free-code” 不合适

对应：`initial_design.md:1430-1439`

原因：

- free-code 的价值主要在于把快照编译出来，不代表它的 UI 就是最优
- Claude Code 和 Codex 的品质差异，重点不在 UI，重点在 harness、tooling、verification、repo legibility

建议：

- UI 先做到稳定、可观测、低干扰
- 不要把 FreeCode UI clone 作为目标

## 三、我建议的更优方案：围绕“质量优先 + 省 token”

## 设计原则

只保留四条：

1. **常驻上下文必须极小**
2. **确定性反馈优先于 LLM 自省**
3. **repo artifact 优先于对话历史**
4. **只有证明显著增益的 harness 才能进默认路径**

## 推荐架构（MVP）

### A. Core Runtime

- streaming ReAct loop
- typed session state
- tool_result persistence(JSONL)
- resume
- retry / circuit breaker

### B. Token-Minimal Context Engine

- 常驻内容只有：
  - short `AGENTS.md`
  - active task summary
  - loaded tool schemas
  - very recent turns
- tool outputs 默认截断 + 指针化
- compaction 只做一层轻摘要
- 不做 Auto Dream
- 不做 embeddings
- 不做复杂 memory selector

### C. Tooling

- Tier 1 内置：`read/search/edit/create/bash/fetch`
- Tier 2+：MCP defer loading
- Tool Search
- 工具描述 hard cap
- 权限与 sandbox P0

这里建议把“安全/权限”优先级抬高。Anthropic 2026-04-02 公开说，sandboxing 在内部把 permission prompts 降低了 **84%**，这同时提升了安全和自治。  
来源：<https://www.anthropic.com/engineering/claude-code-sandboxing>

### D. Quality Loop

质量不要靠 stop hook 猜“模型是不是想偷懒”，而要靠独立验证链：

1. generator 执行
2. deterministic verification
   - tests
   - typecheck
   - lint
   - format
   - smoke / e2e if available
3. reviewer/evaluator 独立审查高风险改动
4. 失败信号回注入下一轮

也就是：

- **默认靠确定性检查**
- **高风险场景再启 evaluator**

这比“处处加廉价模型 hook”更稳，也更省 token。

### E. Repository as Source of Truth

- `AGENTS.md` 只做目录
- `docs/` 承载架构、设计、约束、执行计划
- active plan/versioned plan 进仓库
- `progress.json` 或 `progress.md` 记录 session 结果

这点上建议更靠近 OpenAI，而不是更像聊天记录系统。

## 四、建议的分阶段落地

### Phase 0：必须先做

- core loop
- 内置 6 工具
- session persistence / resume
- short AGENTS + docs map
- defer-loading tool registry
- deterministic verification pipeline
- sandbox / permission model
- progress artifact

### Phase 1：质量增强，但要克制

- compact summary
- feature list / plan artifact
- isolated evaluator
- codebase index（小型）
- skills progressive disclosure

### Phase 2：确认收益后再做

- task-phase tool scoping
- semantic tool examples
- richer hooks
- background agents
- session reset orchestration

### Phase 3：没有明确证据先不要做

- Auto Dream
- 长期自动记忆
- embedding index
- cache_edits 类 prompt-cache 黑科技
- 复杂 sub-agent fork cache 共享

## 五、我对整体方案的评分

如果按“方向是否对、但是否收敛到可交付系统”来打：

- **方向感：8/10**
- **证据严谨性：6/10**
- **MVP 可落地性：5/10**
- **对 token 目标的忠实度：6/10**

综合评价：

**这不是一份差文档，反而是信息量很强的初步研究；问题不在于它不懂，而在于它想一次把太多次优组件也纳入默认架构。**

Merlion 要对标 Claude Code / Codex，真正该学的是：

- 让 repo 对 agent 友好
- 让工具只在需要时出现
- 让验证链可机械执行
- 让 prompt 和历史保持高信号、低常驻

不是把所有看到的机制都实现一遍。

## 六、还需要继续调研的点

这些值得继续调研，而且我建议优先级如下。

### P0

- `free-code` / `claw-code` 里与 `tool search`、`skill activation`、`session persistence` 直接相关的真实代码路径
- Claude Agent SDK 当前 compaction 行为的边界条件
- 哪些 deterministic checks 对 coding agent 质量提升最大，token 成本最低

### P1

- evaluator 什么时候真的有收益，什么时候只是加钱
- 不同模型上 compaction vs reset 的分界点
- repo docs 结构如何最利于 agent 读取，而不是最利于人类长文浏览

### P2

- prompt cache 命中对真实账单的影响有多大
- 结构索引 vs repo-native docs 的收益差
- skill catalog 的实际触发准确率与误触成本

## 参考资料

- Anthropic, *Effective harnesses for long-running agents*, 2025-11-26  
  <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Anthropic, *Harness design for long-running application development*, 2026-03-24  
  <https://www.anthropic.com/engineering/harness-design-long-running-apps>
- Anthropic, *Introducing advanced tool use on the Claude Developer Platform*, 2025-11-24  
  <https://www.anthropic.com/engineering/advanced-tool-use>
- Anthropic, *Effective context engineering for AI agents*, 2025-09-29  
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic, *Making Claude Code more secure and autonomous with sandboxing*, 2026-04-02  
  <https://www.anthropic.com/engineering/claude-code-sandboxing>
- OpenAI, *Harness engineering: leveraging Codex in an agent-first world*, 2026-02-11  
  <https://openai.com/index/harness-engineering/>
- Agent Skills Specification  
  <https://agentskills.io/specification>
- `free-code` mirror README  
  <https://gitlawb.com/node/repos/z6MkgKkb/paoloanzn-free-code>
- `claw-code` repository  
  <https://github.com/ultraworkers/claw-code>
