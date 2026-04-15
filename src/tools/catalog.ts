import type { ToolDefinition } from './types.js'
import { askUserQuestionTool } from './builtin/ask_user_question.ts'
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
import { lspTool } from './builtin/lsp.ts'
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

type BuiltinToolMetadata = Pick<
  ToolDefinition,
  'source' | 'searchHint' | 'isReadOnly' | 'isDestructive' | 'requiresUserInteraction' | 'requiresTrustedWorkspace'
>

const BUILTIN_TOOL_METADATA: Record<string, BuiltinToolMetadata> = {
  read_file: { source: 'builtin', searchHint: 'read file contents', isReadOnly: true },
  list_dir: { source: 'builtin', searchHint: 'list directory entries', isReadOnly: true },
  stat_path: { source: 'builtin', searchHint: 'inspect file metadata', isReadOnly: true },
  search: { source: 'builtin', searchHint: 'search file contents', isReadOnly: true },
  grep: { source: 'builtin', searchHint: 'grep text patterns', isReadOnly: true },
  glob: { source: 'builtin', searchHint: 'find files by pattern', isReadOnly: true },
  write_file: { source: 'builtin', searchHint: 'overwrite file contents', isDestructive: true },
  append_file: { source: 'builtin', searchHint: 'append to existing file', isDestructive: true },
  create_file: { source: 'builtin', searchHint: 'create new file', isDestructive: true },
  edit_file: { source: 'builtin', searchHint: 'replace text in file', isDestructive: true },
  copy_file: { source: 'builtin', searchHint: 'copy file to path', isDestructive: true },
  move_file: { source: 'builtin', searchHint: 'rename or move file', isDestructive: true },
  delete_file: { source: 'builtin', searchHint: 'delete file or directory', isDestructive: true },
  mkdir: { source: 'builtin', searchHint: 'create directory', isDestructive: true },
  bash: { source: 'builtin', searchHint: 'run shell command', requiresUserInteraction: true },
  run_script: { source: 'builtin', searchHint: 'run package script', requiresUserInteraction: true },
  list_scripts: { source: 'builtin', searchHint: 'list package scripts', isReadOnly: true },
  git_status: { source: 'builtin', searchHint: 'inspect git working tree', isReadOnly: true },
  git_diff: { source: 'builtin', searchHint: 'show git diff', isReadOnly: true },
  git_log: { source: 'builtin', searchHint: 'show git history', isReadOnly: true },
  fetch: { source: 'builtin', searchHint: 'fetch web page', isReadOnly: true },
  lsp: { source: 'builtin', searchHint: 'semantic code navigation and diagnostics', isReadOnly: true },
  tool_search: { source: 'builtin', searchHint: 'find matching tool by capability', isReadOnly: true },
  todo_write: { source: 'builtin', searchHint: 'update todo list', isDestructive: true },
  ask_user_question: { source: 'builtin', searchHint: 'ask the user clarifying questions', requiresUserInteraction: true },
  config: { source: 'builtin', searchHint: 'read or change merlion config', isDestructive: true, requiresUserInteraction: true },
  config_get: { source: 'builtin', searchHint: 'read merlion config value', isReadOnly: true },
  config_set: { source: 'builtin', searchHint: 'change merlion config value', isDestructive: true, requiresUserInteraction: true },
  sleep: { source: 'builtin', searchHint: 'wait before next step' },
}

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
  lspTool,
  toolSearchTool,
  todoWriteTool,
  askUserQuestionTool,
  configTool,
  configGetTool,
  configSetTool,
  sleepTool,
]

export function getBuiltinToolCatalog(): ToolDefinition[] {
  return BUILTIN_TOOL_CATALOG.map((tool) => ({
    ...tool,
    ...BUILTIN_TOOL_METADATA[tool.name],
  }))
}
