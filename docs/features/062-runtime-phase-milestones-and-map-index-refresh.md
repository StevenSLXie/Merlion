# Feature 062: Runtime Phase Milestones + Map/Index Refresh

Status: `done`  
Type: `P0 UX + Context`

## Goal

解决三个体验/可用性问题：

1. 工具调用期间缺少阶段性结论提示，用户只能看流水日志。  
2. `Codebase Index` 容易混入噪声文件，且结构区块不随实际改动刷新。  
3. generated map 只在 session 启动初始化，空项目从脚手架到 commit 期间地图不会扩展。  
4. TUI 下 markdown 表格可读性弱（看起来像原始 markdown）。

## Implementation

- 新增 `src/runtime/tool_batch_milestones.ts`：
  - 基于通用信号生成阶段提示（质量检查通过、批次成功/失败汇总、提交命令成功）。
  - 在 `src/index.ts` 的 `onToolBatchComplete` 中输出 `[phase] ...`。
- `src/artifacts/codebase_index.ts`：
  - 增加噪声过滤目录/后缀（如 `__pycache__`、`.pyc`、`.pytest_cache`）。
  - 新增 `refreshCodebaseIndex` 全量重建（保留 recent changed）。
  - `updateCodebaseIndexWithChangedFiles` 改为“合并 changed + 重建索引主体”。
- `src/index.ts`：
  - 变更路径采集从“仅 create/edit”扩展到常见写操作工具。
  - 增加 `git status --porcelain` 工作树兜底采样，覆盖 bash 脚手架写入场景。
  - 在 generated map 模式下，检测到工作树变更或 commit 后刷新 `.merlion/maps`。
- `src/artifacts/agents_bootstrap.ts`：
  - 增加 `force` 选项，支持无 HEAD 变化时强制重建地图。
- `src/cli/markdown.ts`：
  - markdown 表格渲染改为 box-drawing 形式（`┌┬┐ / │ │ / └┴┘`）。
  - 新增 pipe-table 段落兜底解析。

## Files

- `src/index.ts`
- `src/cli/experience.ts`
- `src/cli/markdown.ts`
- `src/runtime/tool_batch_milestones.ts`
- `src/artifacts/codebase_index.ts`
- `src/artifacts/agents_bootstrap.ts`
- `tests/tool_batch_milestones.test.ts`
- `tests/artifacts_codebase_index.test.ts`
- `tests/artifacts_agents_bootstrap.test.ts`
- `tests/cli_markdown.test.ts`

## Verification

- `node --experimental-strip-types --test tests/tool_batch_milestones.test.ts`
- `node --experimental-strip-types --test tests/artifacts_codebase_index.test.ts`
- `node --experimental-strip-types --test tests/artifacts_agents_bootstrap.test.ts`
- `node --experimental-strip-types --test tests/cli_markdown.test.ts`
- `npm run typecheck`
