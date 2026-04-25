# 107 Cache-Aware Cost Gate And Prefix Stability

Status: `implemented`  
Type: `P0 Runtime Cost / Observability`

## Goal

把当前已经落地的 E2E cache-aware cost gate、shared usage helper 与 prefix stability 诊断
固定成明确的数据契约，避免后续维护再次退回到粗糙的 `total_tokens` 代理，
并继续防止：

1. `gate 通过，但真实账单更贵`
2. `gate 失败，但其实大部分 prompt 已缓存`
3. 只看 `total_tokens` 时看不出是 prompt floor 变胖，还是 cache hit 变差

这个 feature 的目标不是回退 106 的工具收敛，也不是强行让所有路径都传全量 schema，
而是让“预算门槛”与“真实成本来源”重新对齐。

## Why

106 已经证明：

- 简单场景在默认全量工具 schema 下，`total_tokens` 会明显虚高
- 工具暴露收敛后，5 个基础 E2E 的 `total_tokens` 能显著下降

但这还没有解决另一个更根本的问题：

- provider 的真实成本并不只看 `total_tokens`
- 如果跨轮 / 跨次调用前缀高度稳定，`cached_tokens` 可以显著抵消输入成本
- 反过来，如果 capability profile、tool schema、system prelude 经常抖动，
  即使 `total_tokens` 没暴涨，真实账单也可能变差

当前仓库里已经能记录 `cached_tokens`、计算 `calculateUsageCostUsd()`，
并让 E2E cost gate 以 cache-aware primary metric 做 baseline 比较。
这个 spec 的作用是把已经交付的约束写清楚，避免后续 feature 漂移。

## Evidence

### 1. 当前 cost gate 已经支持 cost-primary + raw-token guardrail

以 2026-04-25 仓库快照为准，`src/runtime/cost_gate.ts` 当前已经支持：

- 读取 `derivedMetrics`
- 在 `estimated_cost_usd` 与 `effective_total_tokens` 之间选择 primary metric
- 将 `total_tokens` 作为独立 guardrail
- 兼容旧版只提供 `total_tokens` baseline 的 schema

也就是说：

- `cached_tokens` 已经能通过 `derivedMetrics` 影响 gate
- `estimated_cost_usd` 已经可以参与 gate
- `uncached / billable prompt` 已经通过 `effective_total_tokens` 参与 gate

### 2. usage 层已经提供 shared cache-aware 原语

当前 `src/runtime/usage.ts` 已经支持：

- 记录 `cached_tokens`
- 聚合 `prompt_tokens` / `completion_tokens` / `cached_tokens`
- 用 `calculateUsageCostUsd()` 按非缓存输入、缓存输入、输出分别计算估算成本

这说明 gate 与 archive 都已经接上 shared usage contract，本 spec 不应再要求第二套实现。

### 3. 106 解决的是 prompt floor，107 补齐 gate 与诊断语义

106 的修复方向是对的：

- 收窄基础 E2E 的工具暴露
- 降低 prompt floor
- 让简单场景不再为无关工具 schema 付费

当前 contract 的意义在于继续防止以下语义错位重新出现：

- `total_tokens` 变好看，不等于真实美元成本一定最优
- 如果每轮 tool profile / schema 都变化，cache hit 仍然可能下降
- gate / archive 不应再次退回到无法区分“raw prompt 变胖”与“cache rate 变差”的状态

## Problem Statement

当前真正需要防止的问题不是“仓库里还没有 cache-aware gate”，
而是后续改动重新把下面这些 truth source 拉散：

1. provider usage 里的 `cached_tokens`
2. runtime shared helper 里的 `calculateUsageCostUsd()` / `deriveUsageMetrics()`
3. E2E helper 与 archive 对 primary metric / degraded reason 的消费方式

如果这些 contract 再次分叉，结果仍然会是：

- gate 重新偏离真实计费压力
- cache hit regression 被 `total_tokens` 掩盖
- raw prompt floor regression 与 cache regression 无法拆分定位
- archive 与 gate 输出无法稳定对齐

## Scope

已交付范围包括：

- `src/runtime/cost_gate.ts` 的 metric 模型升级
- `docs/cost-baseline.json` schema 的扩展
- E2E usage archive / helper 的 derived billing metrics 补齐
- 供 E2E 与 CLI/runtime observability 共同复用的 rate resolution / derived metric helper 抽取
- cache-aware gate 与 raw token gate 的职责拆分
- prefix stability / cache hit triage 所需的最小可观测性增强

不包括：

- 在 CLI / wechat / 其他正式运行路径里新增用户可见的强制 cost gate
- 回退 106 的工具 profile 收敛
- 强制主 runtime 改回“全量工具 schema”
- provider 切换
- 修改通用 `runLoop()` primitive 的默认语义
- 在本 feature 中重写大块 system prompt / orientation 内容

## Design Principles

1. 主预算 gate 应优先反映真实 billable cost，而不是只反映 raw token 体积。
2. `total_tokens` 仍然重要，但它更适合作为 prompt-size / context-pressure guardrail，而不是唯一成本 truth source。
3. cache-aware gate 不应鼓励“为了缓存命中而故意传无关工具”。
4. 诊断信息必须能区分：
   - raw prompt 变胖
   - uncached prompt 变大
   - cache hit 变差
   - completion 自身变大

## Candidate Directions

### A. Effective Input Token Gate

把 gate 的核心指标改成类似：

- `effective_input_tokens = prompt_tokens - cached_tokens`

或者：

- `billable_input_tokens = non_cached_prompt_tokens + discounted_cached_prompt_tokens`

优点：

- 不依赖外部价格配置
- 比 `total_tokens` 更接近真实输入成本

风险：

- 仍然没有把输出 token 单独计入真实成本
- 不同 provider 对 cached input 的折扣不同

### B. Estimated USD Gate

直接复用 `calculateUsageCostUsd()`，
让 gate 基于：

- `estimated_cost_usd`

优点：

- 最贴近真实账单
- 能把 cached input / uncached input / output 一起纳入

风险：

- 依赖稳定的费率配置
- 没有费率时需要 fallback

### C. Dual Gate: Cost-Primary, Token-Secondary

将 gate 拆成两层：

1. 主 gate：cache-aware billable metric
2. 次 gate：raw token / prompt-size guardrail

例如：

- 主 gate：`estimated_cost_usd` 或 `effective_input_tokens`
- 次 gate：`total_tokens` 或 `prompt_floor_tokens`

优点：

- 既不丢掉真实成本
- 也不失去 prompt 膨胀预警

风险：

- baseline schema 会更复杂
- 报错文案需要更清楚，避免用户看不懂哪个 gate 失败

### D. Prefix Stability Diagnostics

补齐 archive / observability 的派生字段，例如：

- `uncached_prompt_tokens`
- `cached_prompt_ratio`
- `effective_input_tokens`
- `estimated_cost_usd`
- 每轮 `stable_prefix_ratio`
- 每轮实际 tool schema hash / token estimate

优点：

- 后续可以直接判断 cache regression 是否来自 schema/profile 抖动

风险：

- 只增强可观测性，不直接修 gate

## Recommended Direction

当前仓库已经按 `C + D` 落地：

1. 主 gate 使用 cache-aware billable metric
2. 保留 raw token guardrail 作为次级诊断
3. archive 落盘 prefix stability / effective cost 派生字段

如果缺少 shared provider rate 配置，则使用：

- `effective_total_tokens`

作为 cost-primary fallback。

如果 rate 配置存在，则按：

- `estimated_cost_usd`

做主 gate。

## Implementation Constraints

1. 不能因为追求 cache hit 而回退 106 的 profile-based tool exposure 收敛。
2. 当 provider 没有返回 `cached_tokens` 时，必须显式写入 `primary_metric_degraded_reason`，并停止把缺失样本计作 cached discount；若 shared rates 仍然存在，则 primary metric 仍可保持 `estimated_cost_usd`，否则回退到 `effective_total_tokens`。
3. rate 配置解析必须只有一个 shared source of truth；不要在 `tests/e2e/helpers.ts` 里再复制一套独立 env 解析或价格表。
4. `docs/cost-baseline.json` 的演进必须保持可读，并给出向后兼容路径。
5. 本 feature 中只有 cost-primary gate 可以阻塞测试失败；raw-token guardrail 默认只做诊断/告警，不新增第二个默认 blocking gate。
6. gate 失败信息必须明确说明：
   - 失败的是 cost-primary gate 还是 raw-token guardrail
   - 对应阈值和实测值分别是什么
7. E2E helper 不应自己复制一套独立计费公式，优先复用 runtime 侧公共 helper。
8. archive 的最小落盘形态必须固定，至少要有一组稳定命名的 top-level derived totals，避免把判定信息埋进自由格式日志里。

## Data Contract

为避免实现期继续发散，本 feature 采用下面这组最小数据契约：

1. `usage_samples` 继续保留 provider 原始 `prompt_tokens` / `completion_tokens` / `cached_tokens`
2. archive 顶层新增 `derived_totals`，至少包含：
   - `uncached_prompt_tokens`
   - `cached_prompt_ratio`
   - `effective_input_tokens`
   - `effective_total_tokens`
   - `estimated_cost_usd`（有 shared rate 配置时）
   - `primary_metric`
   - `primary_metric_value`
   - `primary_metric_degraded_reason`（无降级则为 `null`）
3. `prompt_observability` 保持逐轮快照，继续承担 prefix stability 诊断；本 feature 不要求再发明第二套逐轮 cost archive

这样做的目的是：

- gate 判定能直接对齐 archive 顶层字段
- triage 时先看 `derived_totals`，再下钻 `prompt_observability`
- 控制本 feature 范围，不把 archive 重写成另一套 session transcript

## Shipped Contract

1. `src/runtime/cost_gate.ts` 支持 cache-aware primary metric，而不是只吃 `totalTokens`
2. shared helper 暴露统一的 usage rate resolution / derived cost metric 入口，E2E helper 与 CLI/runtime observability 共用它
3. `docs/cost-baseline.json` 支持声明 cost-primary metric，并兼容旧版 `total_tokens` baseline；raw token guardrail 在本 feature 中默认不作为第二个 blocking threshold
4. E2E usage archive 落盘 `Data Contract` 中约定的 `derived_totals`
5. cost gate 输出明确区分：
   - cache-aware cost regression
   - raw token / prompt-size regression
6. 现有 `e2e-read/search/edit/multi-tool/tool-error` 不回退 106 的行为或 schema 收敛
7. 外部-key 验证路径能证明：
   - gate 判定与 cache hit / billable cost 的变化一致

## Validation

当前 contract 的验证至少分四层：

1. 单元测试：
   - `node --experimental-strip-types --test tests/cost_gate.test.ts`
   - `node --experimental-strip-types --test tests/usage.test.ts`
   - `node --experimental-strip-types --test tests/prompt_observability.test.ts`
2. cache / archive 回归：
   - `node --experimental-strip-types --test tests/e2e/helpers_archive.test.ts`
   - `node --experimental-strip-types --test tests/e2e/e2e_cache_hit_rate.test.ts`
3. 外部-key budget 验证：
   - 无 rate 配置时：`MERLION_COST_GATE=fail node --experimental-strip-types --test --test-concurrency=1 tests/e2e/e2e_cache_hit_rate.test.ts tests/e2e/e2e_read.test.ts tests/e2e/e2e_search.test.ts tests/e2e/e2e_edit.test.ts tests/e2e/e2e_multi_tool.test.ts tests/e2e/e2e_tool_error.test.ts`
   - 有 rate 配置时：在同一命令前补上 shared rate env（例如 `MERLION_COST_INPUT_PER_1M` / `MERLION_COST_OUTPUT_PER_1M` / `MERLION_COST_CACHED_INPUT_PER_1M`），并确认 primary metric 从 fallback 切到 `estimated_cost_usd`
   - 仓库内 `docs/cost-baseline.json` 为 `e2e-read/search/tool-error/multi-tool/edit` 预置了 USD baselines；建议用一个固定验证价目表对齐这些 baseline：
     `MERLION_COST_INPUT_PER_1M=1 MERLION_COST_OUTPUT_PER_1M=1 MERLION_COST_CACHED_INPUT_PER_1M=0`
     这样 `estimated_cost_usd` 会与 `effective_total_tokens / 1_000_000` 保持同一标尺，方便 reviewer 直接确认 “同一组 targeted E2E 在无 rate 时走 fallback、有 rate 时切到 USD-primary”。
4. 全仓回归：
   - `npm run test:all`

如果没有 `OPENROUTER_API_KEY` 或没有 provider rate 配置，
需要在验证说明里明确标出哪些校验走了 `effective_total_tokens` fallback。

## Acceptance Criteria

1. cost gate 的主判定不再只依赖 `total_tokens`
2. 当 `cached_tokens` 可用时，gate 能体现 cache-aware billable cost，而不是把缓存前后的输入一视同仁
3. 当 `cached_tokens` 不可用时，gate 会明确记录 `derived_totals.primary_metric_degraded_reason`；若 shared rates 存在，primary metric 可继续为 `estimated_cost_usd`，否则回退到 `effective_total_tokens`
4. raw token / prompt-size 仍有 guardrail，但在本 feature 中默认不阻塞通过中的场景
5. E2E archive 能直接回答：
   - 这次成本变化主要来自 raw prompt 变胖，还是 cache hit 变差
6. 106 的 5 个场景在行为上保持通过，不因本 feature 回退到全量工具 schema
7. 本 feature 交付后，CLI/runtime 正式路径最多新增共享度量与诊断输出，不新增新的用户可见强制失败语义

## Historical Implementation Order

1. 先抽取 cache-aware derived cost metric 与 archive 字段
2. 再升级 `cost_gate.ts` 和 baseline schema
3. 然后把 5 个基础 E2E 接到新 gate
4. 最后再调整 baseline 文档与验证命令
