# Feature 045: Wave1 Tool Parity And Bundled Ripgrep

Status: `done`  
Type: `P1 tools/runtime`

## Goal

在 Wave1 工具上对齐 free-code 的核心能力边界，并确保 `rg` 在本地开发与 npm 安装后都可用，避免“本地可用/用户不可用”分裂。

## Scope

### 1) Ripgrep runtime parity

- 新增统一 `rg` 执行器，优先使用 `@vscode/ripgrep` 内置二进制，失败再回退系统 `rg`
- `search/glob/grep` 统一走同一执行链
- package 引入 `@vscode/ripgrep`，保证发布包安装后即可使用

### 2) Search/Glob/Grep capability alignment

- `grep` 支持 free-code 核心语义：
  - `output_mode` (`content|files_with_matches|count`)
  - `head_limit` + `offset` 分页
  - `-A/-B/-C/context/-n/-i/type/multiline`
- `search` 作为面向内容检索的别名层，默认 `output_mode=content`
- `glob` 默认 100 条、路径有效性检查、截断提示、排序控制

### 3) Wave1 productivity alignment upgrades

- `tool_search`
  - 支持 `max_results`
  - 支持 `select:<tool_name>` 直接选工具
  - 增加更合理的简单评分排序
- `todo_write`
  - 新增 `todos[]` 全量更新模式（兼容原有 `item` 追加模式）
  - 支持状态：`pending|in_progress|completed`
- `config`
  - 新增统一 `config` 工具（`setting` + 可选 `value`），兼容 `get/set/reset(default)`
  - 保留 `config_get/config_set` 兼容旧调用
- `sleep`
  - 支持 `duration_seconds`（兼容 `duration_ms`）

### 4) npm 安装版默认彩色

- 在 `bin/merlion.js` 中为 TTY 默认注入 `FORCE_COLOR=1`（可被 `NO_COLOR` 或显式 `FORCE_COLOR` 覆盖）

## Framework Compatibility Notes (Why not 1:1)

以下点与 free-code 不能完全 1:1，是当前 Merlion runtime 抽象边界导致：

- free-code 工具返回结构化 schema + rich UI block；Merlion 当前 tool result 以 `content` 字符串为主
- free-code 的 todo 状态在 appState 内存态维护；Merlion 当前以工作区文件持久化模拟（`.merlion/todos.json`）
- free-code config 支持更广设置集合；Merlion 当前仅覆盖 `apiKey/model/baseURL`

## Files

- `package.json`
- `src/tools/builtin/rg_runner.ts`
- `src/tools/builtin/search.ts`
- `src/tools/builtin/grep.ts`
- `src/tools/builtin/glob.ts`
- `src/tools/builtin/tool_search.ts`
- `src/tools/builtin/todo_write.ts`
- `src/tools/builtin/config.ts`
- `src/tools/builtin/index.ts`
- `src/tools/builtin/sleep.ts`
- `bin/merlion.js`
- `tests/tools_fs_pack.test.ts`
- `tests/tools_meta_pack.test.ts`

## Verification

- `npm run typecheck`
- `npm test`
- `node --experimental-strip-types --test tests/tools_fs_pack.test.ts tests/tools_meta_pack.test.ts tests/search.test.ts`
