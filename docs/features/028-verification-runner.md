# Feature 028: Verification Runner (M5-02)

Status: `done`  
Type: `P1 verification`

## Goal

执行 discovery 得到的验证项，产出结构化结果并支持失败反馈给后续修复回合。

## Scope

1. 顺序执行 checks（避免资源争用）
2. 结果结构：`passed/failed/skipped + duration + output`
3. 支持超时与输出截断

## API

- `runVerificationChecks({ cwd, checks, ... })`
  - returns `{ allPassed, results }`

## Runtime Rules

- `requiresEnv` 缺失时 `skipped`
- 超时时判定 `failed`
- 单条输出默认最大 8000 chars

## Exit Criteria

- 单测覆盖 pass/fail/skip/timeout
- 为 fix-round 集成提供稳定输入
