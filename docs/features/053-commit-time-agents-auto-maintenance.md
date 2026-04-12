# Feature 053: Commit-Time AGENTS Auto Maintenance

Status: `done`  
Type: `P1 Workflow`

## Goal

把地图自动维护接到提交流程里：

- 在 commit 前按 staged 改动更新受影响目录链的 AGENTS AUTO。
- push 前校验分区与预算。
- CI 可检查 AUTO 漂移。

## Implementation

- 新增 `scripts/agents/update.ts`：
  - `--staged` 更新受影响目录链。
  - `--all --check` 漂移检查。
  - 自动写入 `RecentChanges` / `HighChurnFiles` / `RecentCommits` / `LastUpdated`。
- 新增 `scripts/agents/lint.ts`：
  - 检查 marker 顺序、必填区块、token 预算。
- 新增 `.githooks/pre-commit` / `.githooks/pre-push`。
- `package.json` 增加 `agents:*` 与 `hooks:install` 脚本。

## Files

- `scripts/agents/update.ts`
- `scripts/agents/lint.ts`
- `.githooks/pre-commit`
- `.githooks/pre-push`
- `package.json`
- `tests/agents_scripts.test.ts`

## Verification

- `node --experimental-strip-types --test tests/agents_scripts.test.ts`
- `npm run agents:lint`
- `npm run agents:check-drift`
