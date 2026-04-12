# Feature 055: Generated Map Bootstrap For Existing Repos

Status: `done`  
Type: `P0 Context`

## Goal

在首次进入“已有项目但没有任何 AGENTS 辅助文件”的场景下，默认生成可用地图，避免 agent 只能做全仓盲搜。

## Implementation

- 新增 `src/artifacts/agents_bootstrap.ts`：
  - 为缺失局部 guidance 的目录自动生成 `.merlion/maps/**/MERLION.md`（兼容历史 `AGENTS.md` 读取）。
  - 生成根目录 + top-level + 部分 second-level 的轻量分层地图（非全仓）。
  - 写入 `.merlion/maps/.meta.json`，按 `HEAD` 做幂等跳过。
- `src/artifacts/agents.ts` 升级为双来源加载：
  - 优先真实 `MERLION.md`，兼容 `AGENTS.md`。
  - 缺失时 fallback 到 `.merlion/maps` 对应目录。
- `src/context/path_guidance.ts` 升级：
  - 路径链加载时同样支持 generated map fallback。
- `src/index.ts` 启动接入 bootstrap：
  - 新 session 自动尝试初始化 generated map。
  - 成功时在 CLI 显示简短 map 初始化提示。
- `scripts/agents/update.ts` / `scripts/agents/lint.ts`：
  - 忽略 `.merlion`，避免把 generated map 当成仓库源地图处理。

## Files

- `src/artifacts/agents_bootstrap.ts`
- `src/artifacts/agents.ts`
- `src/context/path_guidance.ts`
- `src/index.ts`
- `scripts/agents/update.ts`
- `scripts/agents/lint.ts`
- `tests/artifacts_agents_bootstrap.test.ts`
- `tests/e2e/e2e_generated_map_bootstrap.test.ts`

## Verification

- `node --experimental-strip-types --test tests/artifacts_agents_bootstrap.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_generated_map_bootstrap.test.ts`
- `npm run typecheck`
