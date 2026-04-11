import { ToolRegistry } from '../registry.ts'
import { appendFileTool } from './append_file.ts'
import { bashTool } from './bash.ts'
import { configTool } from './config.ts'
import { configGetTool } from './config_get.ts'
import { configSetTool } from './config_set.ts'
import { copyFileTool } from './copy_file.ts'
import { createFileTool } from './create_file.ts'
import { deleteFileTool } from './delete_file.ts'
import { editFileTool } from './edit_file.ts'
import { fetchTool } from './fetch.ts'
import { gitDiffTool } from './git_diff.ts'
import { gitLogTool } from './git_log.ts'
import { gitStatusTool } from './git_status.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { listDirTool } from './list_dir.ts'
import { listScriptsTool } from './list_scripts.ts'
import { mkdirTool } from './mkdir.ts'
import { moveFileTool } from './move_file.ts'
import { readFileTool } from './read_file.ts'
import { runScriptTool } from './run_script.ts'
import { searchTool } from './search.ts'
import { sleepTool } from './sleep.ts'
import { statPathTool } from './stat_path.ts'
import { todoWriteTool } from './todo_write.ts'
import { toolSearchTool } from './tool_search.ts'
import { writeFileTool } from './write_file.ts'

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listDirTool)
  registry.register(statPathTool)
  registry.register(searchTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(writeFileTool)
  registry.register(appendFileTool)
  registry.register(createFileTool)
  registry.register(editFileTool)
  registry.register(copyFileTool)
  registry.register(moveFileTool)
  registry.register(deleteFileTool)
  registry.register(mkdirTool)
  registry.register(bashTool)
  registry.register(runScriptTool)
  registry.register(listScriptsTool)
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(fetchTool)
  registry.register(toolSearchTool)
  registry.register(todoWriteTool)
  registry.register(configTool)
  registry.register(configGetTool)
  registry.register(configSetTool)
  registry.register(sleepTool)
  return registry
}
