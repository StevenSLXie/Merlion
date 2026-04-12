# Feature 052: AGENTS MANUAL/AUTO Contract

Status: `done`  
Type: `P0 Artifacts`

## Goal

建立分层 AGENTS 地图的可维护协议：

- 人工语义区块不被脚本覆盖。
- 自动区块可幂等重放并可校验。
- 自动区块显式包含 `RecentCommits` 和 `LastUpdated`。

## Implementation

- 新增 `src/artifacts/agents_auto.ts`：
  - `MANUAL/AUTO` marker 常量。
  - 模板补全、AUTO 区块渲染、AUTO upsert。
  - 区块结构校验。
- 新增基础 `AGENTS.md`（root/runtime/tools）。

## Files

- `src/artifacts/agents_auto.ts`
- `AGENTS.md`
- `src/runtime/AGENTS.md`
- `src/tools/builtin/AGENTS.md`
- `tests/artifacts_agents_auto.test.ts`

## Verification

- `node --experimental-strip-types --test tests/artifacts_agents_auto.test.ts`
- `npm run typecheck`
