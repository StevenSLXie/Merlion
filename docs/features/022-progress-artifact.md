# Feature 022: Progress Artifact (M4-04)

Status: `done`  
Type: `P0 context artifact`

## Goal

维护一个轻量、结构化、可持续更新的 `progress.md`，让会话续跑时无需重复描述“现在做到哪一步”。

## Scope

1. 自动创建 `.merlion/progress.md`（固定模板）
2. 提供读接口（可按 token 预算截断）
3. 提供更新接口（objective/next/blockers/decisions/done）

## API

- `ensureProgressArtifact(cwd, initialObjective?)`
- `readProgressArtifact(cwd, options?)`
- `updateProgressArtifact(cwd, patch)`

## Template

- `Objective`
- `Done`
- `Next`
- `Blockers`
- `Decisions`

## Test Plan

- 首次调用自动创建模板文件
- patch 更新后内容可读可持久化
- 超预算读取时标记截断

## Exit Criteria

- 单测通过
- 可被 orientation assembler 直接读取并注入
