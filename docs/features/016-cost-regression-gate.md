# Feature 016: Cost Regression Gate

Status: `todo`  
Type: `P1 quality gate`

## Goal

把“省 token = 省成本”变成可回归验证的工程约束，避免后续迭代把成本慢慢抬高。

## Scope

1. 定义基线文件（场景级）：
   - 平均输入 token
   - 平均输出 token
   - 平均总 token
2. 在 CI/本地测试执行后对比基线：
   - 超阈值报警/失败（可配置）
3. 报表沉淀：
   - 时间序列存档（jsonl）
   - 方便对比模型/提示词/工具策略变更

## Baseline Candidates

- e2e_read
- e2e_edit
- e2e_bash
- e2e_multi_tool

## Rules (initial)

- 默认阈值：总 token 较基线上涨 >20% 触发失败
- 支持 `MERLION_COST_GATE=warn` 降级为警告模式

## Exit Criteria

- 测试跑完自动输出基线对比结果
- 至少 4 个 E2E 场景纳入 gate
