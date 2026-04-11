# Feature 027: Verification Check Discovery (M5-01)

Status: `done`  
Type: `P1 verification`

## Goal

从仓库上下文自动发现可执行验证项，避免硬编码固定检查链。

## Discovery Source

- `package.json` scripts（优先）
  - `typecheck`
  - `test`
  - `test:e2e`
  - `lint`

## Rules

1. 返回固定顺序：`typecheck -> test -> test:e2e -> lint`
2. `test:e2e` 默认标记需要 `OPENROUTER_API_KEY`
3. 未发现脚本时返回空列表（由上层决定如何处理）

## API

- `discoverVerificationChecks(cwd)`

## Exit Criteria

- 单测覆盖发现顺序、缺脚本、e2e 环境依赖
