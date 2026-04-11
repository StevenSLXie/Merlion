# Feature 021: AGENTS Loader (M4-03)

Status: `done`  
Type: `P0 context artifact`

## Goal

把项目内 `AGENTS.md` 规则稳定注入会话起始上下文，减少模型重复探索工程规范的 token 成本。

## Scope

1. 从项目根到当前 cwd 分层加载 `AGENTS.md`
2. 统一拼接为可注入文本（根 -> 子目录顺序）
3. 支持预算截断（默认约 500 tokens）

## API

- `loadAgentsGuidance(cwd, options)`
  - 输出：`text`, `files`, `tokensEstimate`, `truncated`

## Test Plan

- 多层 AGENTS 文件按顺序加载
- 无文件时返回空结果
- 超预算时截断并标记 `truncated=true`

## Exit Criteria

- 单测通过
- 可被后续 orientation assembler 直接调用
