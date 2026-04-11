# Feature 043: Free-code Tool Survey And Wave1 Implementation

Status: `done`  
Type: `P1/P2 tools`

## Goal

参照 `free-code/src/tools`，做“批判性选型”而非照搬，实现对 Merlion 最有价值的一批内置工具：

- 优先提升编码效率（文件导航/编辑/运行/git）
- 严控复杂度与 token 成本
- 保持可测试、可维护

## Critical Survey (by importance)

`free-code` 工具可分 4 层：

1. **Core coding loop（最高优先）**
   - `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `BashTool`, `WebFetchTool`
2. **Execution/productivity（高优先）**
   - `TodoWriteTool`, `ToolSearchTool`, `ConfigTool`, `SleepTool`
3. **Coordination/orchestration（中优先）**
   - `Task*`, `Team*`, `AgentTool`, `WorkflowTool`, `PlanMode*`
4. **Platform-specific/integration（低优先，按需）**
   - `LSPTool`, `NotebookEditTool`, `MCP*`, `RemoteTriggerTool`, `ScheduleCronTool`

对 Merlion Phase1 的取舍：

- 立即实现 1+2 中的关键子集（Wave1）
- 暂不引入 3/4（需要更复杂运行时协议和状态机，短期 ROI 低）

## Wave1 Implemented Tools

在已有 `read_file/search/create_file/edit_file/bash/fetch` 基础上，新增 20 个工具：

### Filesystem / Navigation

- `list_dir`
- `glob`
- `grep`
- `write_file`
- `append_file`
- `delete_file`
- `move_file`
- `copy_file`
- `mkdir`
- `stat_path`

### Execution / Git

- `list_scripts`
- `run_script`
- `git_status`
- `git_diff`
- `git_log`

### Productivity / Config

- `tool_search`
- `todo_write`
- `config_get`
- `config_set`
- `sleep`

## Design Notes

- 文件写操作统一做 workspace 边界约束 + permission gate
- 执行类工具统一用 `process_common`（timeout + output truncation）
- `tool_search` 通过 `ToolContext.listTools()` 获取当前注册工具，避免硬编码
- 配置工具复用 `src/config/store.ts`

## Files Added

- `src/tools/builtin/fs_common.ts`
- `src/tools/builtin/process_common.ts`
- `src/tools/builtin/list_dir.ts`
- `src/tools/builtin/glob.ts`
- `src/tools/builtin/grep.ts`
- `src/tools/builtin/write_file.ts`
- `src/tools/builtin/append_file.ts`
- `src/tools/builtin/delete_file.ts`
- `src/tools/builtin/move_file.ts`
- `src/tools/builtin/copy_file.ts`
- `src/tools/builtin/mkdir.ts`
- `src/tools/builtin/stat_path.ts`
- `src/tools/builtin/list_scripts.ts`
- `src/tools/builtin/run_script.ts`
- `src/tools/builtin/git_status.ts`
- `src/tools/builtin/git_diff.ts`
- `src/tools/builtin/git_log.ts`
- `src/tools/builtin/tool_search.ts`
- `src/tools/builtin/todo_write.ts`
- `src/tools/builtin/config_get.ts`
- `src/tools/builtin/config_set.ts`
- `src/tools/builtin/sleep.ts`

## Tests Added

- `tests/tools_fs_pack.test.ts`
- `tests/tools_meta_pack.test.ts`
- `tests/tools_git_pack.test.ts`

## Remaining (Wave2)

- `web_search`（provider-aware + quoting/citation policy）
- notebook/lsp-like语义工具（需更重协议）
- task/team/agent/orchestration 工具（需多agent runtime）
