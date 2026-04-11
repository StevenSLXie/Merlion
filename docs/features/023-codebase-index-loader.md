# Feature 023: Codebase Index Loader (M4-05)

Status: `done`  
Type: `P0 context artifact`

## Goal

提供一个稳定、轻量、可增量更新的代码地图，减少每次会话对仓库结构的重复探索。

## Scope

1. 自动生成 `docs/codebase_index.md`（首次）
2. 读取接口支持预算截断
3. 增量更新接口：记录最近 changed files（供 runtime/tool 回调更新）

## API

- `ensureCodebaseIndex(cwd)`
- `readCodebaseIndex(cwd, options?)`
- `updateCodebaseIndexWithChangedFiles(cwd, changedPaths)`

## Test Plan

- 首次生成包含核心 section
- 更新 changed files 时去重并写入
- 读取时可按 token budget 截断

## Exit Criteria

- 单测通过
- orientation assembler 可直接消费 index 文本
