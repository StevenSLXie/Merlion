# Feature 019: E2E Cost Gate Implementation

Status: `done`  
Type: `P1 quality gate`

## Goal

在 E2E 运行后自动对比 token 基线，超阈值时告警或失败，防止成本回归。

## Scope

1. 基线文件：`docs/cost-baseline.json`
2. gate 核心：`evaluateCostGate`（pass/warn/fail/skip）
3. E2E helper 接入：
   - 写 usage archive 后执行 gate
   - 支持 `MERLION_COST_GATE=fail|warn|off`

## Defaults

- 默认模式：`fail`
- 默认阈值：`20%`

## Test Plan

- `tests/cost_gate.test.ts`：
  - 阈值内 pass
  - 超阈值 warn
  - 超阈值 fail
  - baseline 缺失时 skip

## Exit Criteria

- E2E 跑完自动执行 gate
- 支持环境变量切换模式
