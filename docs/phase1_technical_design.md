# Merlion 第一期技术方案（V1）

日期：2026-04-11  
输入材料：

- [initial_design.md](/Users/xieshuanglong/Documents/Code/Merlion/initial_design.md)
- [initial_design_review.md](/Users/xieshuanglong/Documents/Code/Merlion/initial_design_review.md)

---

## 1. 目标与约束

### 1.1 产品目标

Merlion 的核心目标只有两个：

1. **质量对标 Claude Code / Codex**
2. **在不牺牲质量的前提下尽可能省成本**

这里“省 token”不是最终目标，只是省成本的一个手段。  
因此第一期方案不能只优化 token 数，还必须优化：

- 缓存命中率
- 输出 token 规模
- 无效循环次数
- 不必要的工具 schema 常驻
- 不必要的模型辅助流程

### 1.2 第一期边界

第一期只解决下面四件事：

- 把核心 coding agent 跑通并可持续迭代
- 让 agent 在真实代码任务上具备稳定的读写、执行、验证能力
- 让上下文和工具常驻成本足够低
- 让长任务可以持续进行，但不引入过多二级系统

第一期**不做**：

- 长期自动记忆
- embedding / 向量索引
- 复杂 Auto Dream
- 重型 hook runtime
- 多种 sub-agent 模式
- 依赖逆向接口的 prompt-cache 黑科技

---

## 2. 关键判断

### 2.1 我们应该学什么

从 Claude Code、Codex、Anthropic/OpenAI 官方工程文章看，真正稳定有效的不是某个“神奇 prompt”，而是：

- 小而稳定的常驻上下文
- 工具按需加载
- repo 内结构化 artifact
- 可机械执行的验证链
- 明确的权限与沙箱
- 会话持久化与可恢复

### 2.2 我们不应该学什么

第一期不应该把下面这些当成默认能力：

- 复杂长期 memory
- 依赖二手逆向细节的 cache_edits 方案
- 过重的 compaction schema
- 模型型 hooks 到处介入
- 过细的 sub-agent 分类

原因很直接：这些能力要么证据不够稳定，要么会自己消耗 token / 工程复杂度，反而削弱“高质量 + 低成本”。

---

## 3. 当前主要提供商的计费结构与对方案的影响

以下价格均基于 2026-04-11 可见官方文档。

### 3.1 OpenAI

以当前最相关的文本模型为例：

| 模型 | 输入 | Cached input | 输出 |
|---|---:|---:|---:|
| GPT-5.4 | $2.50 / 1M | $0.25 / 1M | $15.00 / 1M |
| GPT-5.4 mini | $0.75 / 1M | $0.075 / 1M | $4.50 / 1M |
| GPT-5.4 nano | $0.20 / 1M | $0.02 / 1M | $1.25 / 1M |

关键结论：

- cached input 是标准输入的 **10%**
- 输出价格远高于输入
- 对 coding agent 来说，**减少重复前缀重传** 和 **减少无意义长输出** 都很重要

来源：<https://openai.com/api/pricing/>

### 3.2 Anthropic

以 Claude 4.5/4.6 系列为例：

| 模型 | Base input | 5m cache write | 1h cache write | Cache hit/read | Output |
|---|---:|---:|---:|---:|---:|
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |

Anthropic 官方还明确说明：

- 5 分钟 cache write = **1.25x** 输入价
- 1 小时 cache write = **2x** 输入价
- cache read = **0.1x** 输入价

这意味着：

- 如果前缀能稳定复用，缓存极值钱
- 但如果 prompt 前缀经常被我们自己改坏，写缓存的收益会迅速下降
- 对 Anthropic 路线来说，**保持 system prompt、工具清单、技能 catalog、artifact 顺序稳定** 非常关键

来源：

- <https://platform.claude.com/docs/en/about-claude/pricing>
- <https://www.anthropic.com/engineering/advanced-tool-use>

### 3.3 Google Gemini

以 Gemini 2.5 系列为例：

| 模型 | 输入 | Context caching | 输出 | 存储 |
|---|---:|---:|---:|---:|
| Gemini 2.5 Pro | $1.25 / 1M（<=200k） | $0.125 / 1M | $10.00 / 1M | $4.50 / 1M tokens/hour |
| Gemini 2.5 Flash | $0.30 / 1M | $0.03 / 1M | $2.50 / 1M | $1.00 / 1M tokens/hour |
| Gemini 2.5 Flash-Lite | $0.10 / 1M | $0.01 / 1M | $0.40 / 1M | $1.00 / 1M tokens/hour |

Google 和 OpenAI/Anthropic 不同的一点是：

- 除了缓存写入成本，还有**缓存存储时长成本**
- 所以过度缓存大体量、低复用内容未必划算

这意味着：

- 对 Gemini 路线，适合缓存的是**高复用稳定前缀**
- 不适合缓存的是频繁变化的大段中间状态

来源：<https://ai.google.dev/gemini-api/docs/pricing>

### 3.4 xAI

xAI 官方页面当前公开了输入/输出价格，但我没有在其公开 API 页面找到 prompt caching 的单独定价说明。

可见价格示例：

| 模型 | 输入 | 输出 |
|---|---:|---:|
| grok-4.20-reasoning | $2.00 / 1M | $6.00 / 1M |
| grok-4.20-non-reasoning | $2.00 / 1M | $6.00 / 1M |
| grok-4-1-fast-reasoning | $0.20 / 1M | $0.50 / 1M |

来源：<https://x.ai/api>

现阶段对 Merlion 的意义是：

- xAI 可以作为兼容目标
- 但第一期架构不应围绕一个未公开明确 cache 计费模型的平台去做专门优化

### 3.5 DeepSeek

DeepSeek 官方当前直接公开了 cache hit / miss 价格：

| 模型入口 | Cache hit input | Cache miss input | 输出 |
|---|---:|---:|---:|
| deepseek-chat / DeepSeek-V3.2 | $0.028 / 1M | $0.28 / 1M | $0.42 / 1M |

这说明它同样是 **10x 的 cache 命中价差**。

来源：<https://api-docs.deepseek.com/quick_start/pricing>

### 3.6 基于定价的总判断

从 OpenAI、Anthropic、Google、DeepSeek 这几家看，结论高度一致：

1. **缓存命中的输入非常便宜**
2. **输出 token 通常比输入贵得多**
3. **频繁变化的大前缀会直接破坏缓存收益**
4. **多做一个模型辅助环节，不只是多一次输入，也多一次输出**

所以 Merlion 的第一期技术方案必须服务于下面三件事：

1. **稳定缓存前缀**
2. **压低常驻输入**
3. **压低无效输出**

---

## 4. 第一期总架构

第一期采用五层架构。

### 4.1 Layer A: Core Runtime

职责：

- 接收用户输入
- 组装请求
- 流式接收模型输出
- 执行工具
- 记录 transcript
- 控制循环终止

核心要求：

- `AsyncGenerator` 风格接口
- typed session state
- 工具结果 append-only 记录
- per-tool-call 持久化
- 支持 resume

### 4.2 Layer B: Context Engine

职责：

- 决定本轮真正发给模型的上下文
- 截断低价值内容
- 保持稳定前缀
- 在必要时做轻量 compaction

设计原则：

- **默认不做重型摘要**
- **默认不做多层 memory**
- **默认不引入额外模型调用**

### 4.3 Layer C: Tooling

职责：

- 内置核心工具
- 外部工具注册
- 工具 schema 按需加载
- 并发执行与权限控制

### 4.4 Layer D: Verification

职责：

- 把质量判断尽量转成可执行检查
- 把失败信号直接反馈给下一轮 agent loop

这里是 Merlion 第一期的质量核心，而不是 memory。

### 4.5 Layer E: Repository Artifacts

职责：

- 把跨 session、跨压缩仍需要存在的信息，写成 repo 或 sidecar 中的结构化文件

这是降低对“完整对话历史”依赖的关键。

---

## 5. 第一期核心设计

## 5.1 ReAct 主循环

### 保留项

- 最小 streaming ReAct loop
- `tool_use -> execute -> tool_result -> continue`
- 空 tool_result 占位
- max output 恢复
- 413 / context overflow 的 circuit breaker
- 每次工具调用后立即写 JSONL

### 不做项

- 复杂 stop hook 猜测模型是否想“偷懒”
- 多种子 agent 调度模式
- hook 内再套模型判断

### 设计原因

真正让 coding agent 质量稳定的不是循环写得花，而是：

- 会不会卡死
- 会不会无限重试
- 会不会丢失执行状态
- 会不会因为工具结果不对称把消息结构打坏

这些都是 P0。

## 5.2 Context Engine

### 常驻上下文只保留四类

1. 短 `AGENTS.md`
2. 当前任务摘要
3. 已加载工具 schema
4. 最近几轮高价值消息

### 工具输出处理策略

- 默认对大工具输出做预算截断
- 截断后保留：
  - command / file path
  - exit code / 状态
  - 前后若干行
  - `...[truncated]`
- 不保留整段低价值日志

### Compaction 策略

第一期只做 **单层轻摘要**：

- summary schema 只保留：
  - current objective
  - verified facts
  - pending work
  - important file pointers

不做：

- 9-section full compact
- All User Messages 完整保留
- Auto Dream
- 多层 warm/cold/embedding memory

### 为什么这样做

从价格上看，第一期最重要的是：

- 保持静态前缀稳定
- 不把中间低价值内容反复重传

而不是把所有旧信息“压缩得很完整”。

## 5.3 工具系统

### Tier 1 内置工具

第一期固定为 6 个：

- `read_file`
- `search`
- `create_file`
- `edit_file`
- `bash`
- `fetch`

### 工具设计原则

- 描述极短
- 参数 schema 尽量小
- 只读工具允许并发
- 写入和副作用工具串行
- 工具错误返回 tool_result，不直接炸掉主循环

### Tool Registry

保留：

- builtin / extension / mcp 三类来源
- defer loading
- session-scoped loaded state

第一期不做：

- 复杂 task-phase tool scoping
- 工具级 token 成本预测模型

### Tool Search

第一期保留，但目标要收敛：

- 当工具清单过大时，先向模型暴露短 catalog
- 需要时再拉完整 schema

这直接服务于两件事：

- 降低常驻输入
- 稳定缓存前缀

## 5.4 Skill 系统

第一期保留渐进披露，但只做最小实现。

### 保留项

- 多目录发现
- `name + description` catalog
- 激活后读取 `SKILL.md`
- `references/` 按需
- skill token 上限

### 不做项

- GitHub 安装市场
- 复杂信任模型之外的更多能力
- compaction 后复杂 skill 重附加逻辑

### 原则

Skill 是“按需扩展指令”，不是“永久驻留说明书”。

## 5.5 Session Persistence

第一期必须有：

- JSONL transcript
- resume
- compact boundary
- aborted tool 的合成结果

这是长任务质量的 P0，不是 P1。

如果没有恢复能力，所有其他优化都不稳。

## 5.6 Repository Artifact

第一期建议保留三类 artifact：

### 1. `AGENTS.md`

定位：

- 目录
- 规则入口
- 文档索引

不是百科全书。

### 2. `progress.md` 或 `progress.json`

记录：

- 本 session 已完成
- 当前状态
- 已知问题
- 下一步

### 3. `feature_list.json` 或 `task_plan.json`

记录：

- 任务拆分
- 当前是否完成
- 验证状态

这样做的目的，是减少 agent 对长对话历史的依赖。

### 关于 `codebase_index`

第一期可以做一个小型 `codebase_index.md`，但只作为辅助索引，不作为唯一真相来源。

真正的 source of truth 仍然是：

- repo docs
- active plan
- progress artifact

## 5.7 Verification Loop

这是第一期的质量中枢。

### 第一期必须做的 deterministic checks

- `test`
- `typecheck`
- `lint`
- `format --check` 或同类检查
- 项目已有的 smoke / e2e

### 工作方式

1. agent 实现改动
2. harness 运行可用的 deterministic checks
3. 将失败结果结构化注入下一轮上下文
4. agent 修复

### 为什么这比模型型 hooks 更重要

因为 deterministic checks：

- 更便宜
- 更稳定
- 更可观测
- 更接近真实质量

### Evaluator

第一期不作为默认路径，只作为高风险或用户显式要求时的增强路径。

原因：

- evaluator 需要额外输入和额外输出
- 在定价上，它只有在高风险任务里才足够值

## 5.8 权限与沙箱

权限与沙箱在第一期是 P0。

原因不是安全宣传，而是成本。

如果没有稳定的沙箱与权限模型：

- agent 会频繁请求确认
- 用户会频繁介入
- 循环会被打断
- 任务完成时间和总输出都会膨胀

第一期要求：

- destructive bash 检测
- 权限请求机制
- 最少可用沙箱边界
- 失败信息结构化回传

---

## 6. 第一期开发表

## 6.1 P0

- Core runtime
- Streaming ReAct loop
- 6 个内置工具
- Tool registry 基础结构
- defer loading
- JSONL transcript persistence
- resume
- 轻量 context budget/truncation
- 单层 compact summary
- deterministic verification pipeline
- 权限与沙箱
- `AGENTS.md` + progress artifact

## 6.2 P1

- Tool Search
- feature/task artifact
- 小型 `codebase_index.md`
- skill progressive disclosure
- isolated evaluator（非默认）

---

## 7. 第二期可做项

第二期的原则不是“把第一期没做的都补上”，而是只做那些已经证明能提升质量/成本比的能力。

### 7.1 优先级最高

#### 1. Tool Search 增强

- 更好的工具召回
- 工具加载后的 session 缓存策略
- 工具使用统计

前提：

- 第一期开启 defer loading 后，确实发现工具选择仍是主要瓶颈

#### 2. Isolated Evaluator

- 针对高风险改动做独立审查
- 支持 review-only / verify-only 模式

前提：

- deterministic checks 之后仍有明显漏检

#### 3. 小型 codebase index 自动刷新

- 维护热区
- 维护模块映射

前提：

- 真实数据证明冷启动探索成本高

### 7.2 中优先级

#### 4. Task-phase tool scoping

- research / execute / verify 的工具集切换

前提：

- 当前全量 loaded tools 依然太贵

#### 5. Context reset orchestration

- 对超长任务，在满足条件时从 compaction 切到 reset

前提：

- 连续 compact 导致质量明显下降

#### 6. Background workers

- 把非关键路径任务异步化

前提：

- 主循环已有成熟会话管理

### 7.3 低优先级

#### 7. 长期 memory

- 手动 pin 之外的自动 memory 选择

#### 8. Embedding / semantic index

- 本地向量检索

#### 9. Rich hooks

- prompt/http/agent hook

#### 10. Prompt-cache 特化优化

- 仅当账单和 trace 证明 prompt cache 命中率已成为头号变量时，再研究更激进的 cache-aware message shaping

---

## 8. 基于成本模型反推的最终技术结论

### 8.1 我们最该优化的不是“token 总量”，而是三件事

1. **高复用前缀是否稳定**
2. **工具和技能是否常驻过多**
3. **验证链是否制造了过多无效输出**

### 8.2 因此第一期的最终取舍是

#### 必须做

- 短 system/AGENTS
- 工具按需加载
- 技能渐进披露
- 轻量 compaction
- transcript/resume
- deterministic verification
- 权限/沙箱

#### 暂时不做

- 自动长期记忆
- embedding
- 重型 compact schema
- 到处加模型型 hook
- 多种复杂 sub-agent 模式

### 8.3 为什么这套方案最符合“质量对标 Claude Code / Codex，同时省成本”

因为它遵循了当前价格结构下的最优方向：

- 用 artifact 和 docs 替代冗长聊天历史
- 用 defer loading 替代大工具常驻
- 用 deterministic checks 替代廉价模型反复自省
- 用稳定前缀换取缓存收益
- 用小而稳的核心架构，避免过度 harness 化本身变成成本源

---

## 9. 需要继续验证的指标

第一期实现后，必须真实打点下面几组指标，否则后续优化会失真。

### 成本指标

- 每个任务总输入 token
- 每个任务 cached input token
- 每个任务输出 token
- 每个任务工具 schema token
- 每个任务 verification token

### 质量指标

- 首次通过率
- 最终通过率
- 平均修复轮次
- premature exit 发生率
- resume 后成功继续率

### 工程指标

- tool load 命中率
- compact 触发频率
- permission interrupt 次数
- deterministic checks 平均耗时

---

## 10. 参考资料

- OpenAI API Pricing  
  <https://openai.com/api/pricing/>
- Anthropic Claude API Pricing  
  <https://platform.claude.com/docs/en/about-claude/pricing>
- Anthropic, *Introducing advanced tool use on the Claude Developer Platform*  
  <https://www.anthropic.com/engineering/advanced-tool-use>
- Anthropic, *Effective harnesses for long-running agents*  
  <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Anthropic, *Harness design for long-running application development*  
  <https://www.anthropic.com/engineering/harness-design-long-running-apps>
- Anthropic, *Making Claude Code more secure and autonomous with sandboxing*  
  <https://www.anthropic.com/engineering/claude-code-sandboxing>
- Google Gemini API Pricing  
  <https://ai.google.dev/gemini-api/docs/pricing>
- xAI API  
  <https://x.ai/api>
- DeepSeek Pricing  
  <https://api-docs.deepseek.com/quick_start/pricing>
