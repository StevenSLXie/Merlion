# Feature 064: Semantic Map/Index Orientation + Auto Progress Pipeline

Status: `done`  
Type: `P0 Context/Runtime`

## Goal

将“按图索骥”从被动、弱语义、弱维护，升级为可持续的闭环：

1. 新 session 能主动获得 root + 关键目录地图，不依赖先跑路径工具。  
2. `codebase_index.md` 从“文件清单”提升为“结构 + 语义 + 变更信号”。  
3. 变更后自动写入 `progress.md`（尤其 commit 后），降低跨 session 丢失。  
4. 对“代码已变、地图未同步”的目录给出陈旧提示。  
5. generated map 增加 `Purpose`，并按项目规模自适应探索深度。

## Scope

### Read path（读端）

- `buildOrientationContext` 支持自适应预算（按项目规模）
- orientation 主动加载 root + 关键子目录 guidance（而非仅 cwd 祖先链）
- index 注入包含目录语义摘要与 guidance scope 交叉引用

### Write path（写端）

- `updateCodebaseIndexWithChangedFiles` 记录 `changed: path — note` 语义变更行
- tool batch/turn 后根据变更自动追加 `progress.md` 的 Done 事件
- 若检测到目录 guidance 可能落后于代码变更，CLI 输出地图陈旧提示
- generated maps 输出 `Purpose`，并基于项目规模调整 bootstrap 深度

## Implementation

- 新增目录语义推断模块，供 index 与 generated map 复用（避免重复逻辑）。
- `codebase_index.ts`：
  - 新增 `## Directory Summary`
  - 新增 `## Guidance Scopes`
  - `Recent Changed Files` 语义化（路径 + 注释）
  - `File Map` 增加 scope 标记
- `agents_bootstrap.ts`：
  - 生成内容增加 `## Purpose`
  - bootstrap target 数量改为按项目规模自适应
- `orientation.ts`：
  - 默认预算从固定值改为自适应
  - 主动加载关键目录 guidance（保持总预算兜底）
- 新增 progress 自动维护模块：
  - 根据 changed files / commit 信息更新 `.merlion/progress.md`
- 新增 guidance 陈旧检测模块：
  - 目录有 `MERLION.md|AGENTS.md` 且文件变更新于地图时，给出 UI hint
- `index.ts`：
  - 接入 auto-progress 与 stale-hint（保持主流程简洁）

## Files

- `src/artifacts/codebase_index.ts`
- `src/artifacts/agents_bootstrap.ts`
- `src/context/orientation.ts`
- `src/index.ts`
- `src/artifacts/repo_semantics.ts` (new)
- `src/artifacts/progress_auto.ts` (new)
- `src/artifacts/guidance_staleness.ts` (new)
- `tests/artifacts_codebase_index.test.ts`
- `tests/orientation.test.ts`
- `tests/artifacts_agents_bootstrap.test.ts`
- `tests/artifacts_progress_auto.test.ts` (new)
- `tests/artifacts_guidance_staleness.test.ts` (new)
- `tests/e2e/e2e_codebase_index_lifecycle.test.ts`

## Verification

- `node --experimental-strip-types --test tests/artifacts_codebase_index.test.ts`
- `node --experimental-strip-types --test tests/orientation.test.ts`
- `node --experimental-strip-types --test tests/artifacts_agents_bootstrap.test.ts`
- `node --experimental-strip-types --test tests/artifacts_progress_auto.test.ts`
- `node --experimental-strip-types --test tests/artifacts_guidance_staleness.test.ts`
- `node --experimental-strip-types --test tests/e2e/e2e_codebase_index_lifecycle.test.ts`
- `npm run -s typecheck`
