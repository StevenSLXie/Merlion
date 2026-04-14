import type { ToolDefinition } from './types.js'
import { appendFileTool } from './builtin/append_file.ts'
import { bashTool } from './builtin/bash.ts'
import { configTool } from './builtin/config.ts'
import { configGetTool } from './builtin/config_get.ts'
import { configSetTool } from './builtin/config_set.ts'
import { copyFileTool } from './builtin/copy_file.ts'
import { createFileTool } from './builtin/create_file.ts'
import { deleteFileTool } from './builtin/delete_file.ts'
import { editFileTool } from './builtin/edit_file.ts'
import { fetchTool } from './builtin/fetch.ts'
import { gitDiffTool } from './builtin/git_diff.ts'
import { gitLogTool } from './builtin/git_log.ts'
import { gitStatusTool } from './builtin/git_status.ts'
import { globTool } from './builtin/glob.ts'
import { grepTool } from './builtin/grep.ts'
import { listDirTool } from './builtin/list_dir.ts'
import { listScriptsTool } from './builtin/list_scripts.ts'
import { mkdirTool } from './builtin/mkdir.ts'
import { moveFileTool } from './builtin/move_file.ts'
import { readFileTool } from './builtin/read_file.ts'
import { runScriptTool } from './builtin/run_script.ts'
import { searchTool } from './builtin/search.ts'
import { sleepTool } from './builtin/sleep.ts'
import { statPathTool } from './builtin/stat_path.ts'
import { todoWriteTool } from './builtin/todo_write.ts'
import { toolSearchTool } from './builtin/tool_search.ts'
import { writeFileTool } from './builtin/write_file.ts'

const BUILTIN_TOOL_CATALOG: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  statPathTool,
  searchTool,
  grepTool,
  globTool,
  writeFileTool,
  appendFileTool,
  createFileTool,
  editFileTool,
  copyFileTool,
  moveFileTool,
  deleteFileTool,
  mkdirTool,
  bashTool,
  runScriptTool,
  listScriptsTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  fetchTool,
  toolSearchTool,
  todoWriteTool,
  configTool,
  configGetTool,
  configSetTool,
  sleepTool,
]

export function getBuiltinToolCatalog(): ToolDefinition[] {
  return [...BUILTIN_TOOL_CATALOG]
}
