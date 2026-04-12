# Feature 063: MERLION.md Guidance + Local Session Storage

Status: `done`  
Type: `P0 Context/Runtime`

## Goal

修复两类关键落地问题：

1. `AGENTS.md` 名称冲突与触发误判（仓库任意子目录出现 `AGENTS.md` 会误伤 bootstrap）。  
2. 会话日志默认落在全局目录，导致用户在项目 `.merlion` 下看不到 session 产物。

## Implementation

- Guidance 文件策略升级（兼容迁移）：
  - 读取优先级改为 `MERLION.md > AGENTS.md`。
  - generated map fallback 也支持双文件名读取。
  - path guidance 输出使用“逻辑目录路径 + 文件名”，不暴露 `.merlion/maps` 实现路径。
- Bootstrap 触发策略修复：
  - 移除“全仓任意 `AGENTS.md` 则整体跳过”的短路。
  - 改为按目标目录逐个判断：该目录有真实 guidance 就跳过该目录，否则生成 fallback map。
  - 生成文件默认改为 `.merlion/maps/**/MERLION.md`。
  - `up_to_date` 判定增加“目标目录覆盖完整性”检查。
- Session 存储默认本地化：
  - 默认写入 `<project_root>/.merlion/sessions`。
  - 仍支持 `MERLION_DATA_DIR` 覆盖（兼容原有全局布局）。
  - `--resume` 在未配置 `MERLION_DATA_DIR` 时优先查本地，再回退查历史全局目录 `~/.merlion/projects/<hash>`。
- agents 维护脚本兼容双文件名：
  - `scripts/agents/update.ts` 与 `scripts/agents/lint.ts` 同时识别 `MERLION.md` 与 `AGENTS.md`。

## Files

- `src/artifacts/agents.ts`
- `src/context/path_guidance.ts`
- `src/artifacts/agents_bootstrap.ts`
- `src/runtime/session.ts`
- `scripts/agents/update.ts`
- `scripts/agents/lint.ts`
- `tests/artifacts_agents.test.ts`
- `tests/artifacts_agents_bootstrap.test.ts`
- `tests/e2e/e2e_generated_map_bootstrap.test.ts`
- `tests/session.test.ts`

## Verification

- `node --experimental-strip-types --test tests/artifacts_agents.test.ts`
- `node --experimental-strip-types --test tests/artifacts_agents_bootstrap.test.ts`
- `node --experimental-strip-types --test tests/session.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_generated_map_bootstrap.test.ts`
- `npm run -s typecheck`
