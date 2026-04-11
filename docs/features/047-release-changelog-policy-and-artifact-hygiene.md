# Feature 047: Release Changelog Policy And Artifact Hygiene

Status: `done`  
Type: `P1 process/runtime`

## Goal

1. 版本号变化后，必须有对应 changelog 文件。  
2. 记忆/运行期产物不落到 `docs/`，统一放到 `.merlion/`。

## Changes

### Changelog policy

- 新增测试：`tests/changelog_policy.test.ts`
- 规则：`package.json` 当前版本 `x.y.z` 必须存在文件：
  - `docs/change_log/vx.y.z.log`
- 本次补齐：`docs/change_log/v0.1.4.log`

### Artifact hygiene

- `codebase_index` 路径从 `docs/codebase_index.md` 迁移到：
  - `.merlion/codebase_index.md`
- 同步更新：
  - `src/artifacts/codebase_index.ts`
  - `tests/artifacts_codebase_index.test.ts`
  - `tests/orientation.test.ts`
  - `tests/e2e/e2e_codebase_index_lifecycle.test.ts`
  - `tests/e2e/e2e_orientation_assembly.test.ts`
  - `docs/features/023-codebase-index-loader.md`

### Additional audit

- `progress` 已在 `.merlion/progress.md`（无需迁移）
- `verify` 自定义配置已在 `.merlion/verify.json`（无需迁移）
- `todo_write` 旧默认路径 `docs/todo.md` 改为 `.merlion/todo.md`
  - 可通过显式 `path` 参数覆盖

## Verification

- `npm run typecheck`
- `npm test`
