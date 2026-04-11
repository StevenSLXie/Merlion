# Feature 029: Verification Fix-Round Integration (M5-03)

Status: `done`  
Type: `P1 verification`

## Goal

当验证失败时，自动把失败信号反馈给 agent，再做有限轮修复尝试。

## Scope

1. 新增 fix-round 编排器
2. one-shot CLI 支持 `--verify` / `--no-verify`
3. 每轮把 failed checks 摘要转成修复提示词
4. 轮次上限可配置

## Config

- `MERLION_VERIFY` (`1`/`0`)
- `MERLION_VERIFY_MAX_ROUNDS` (default `2`)
- `MERLION_VERIFY_TIMEOUT_MS` (default `180000`)

## Exit Criteria

- 单测覆盖 fix-round 编排
- one-shot 下 `--verify` 可触发自动修复轮
