import { ToolRegistry } from '../registry.ts'
import { bashTool } from './bash.ts'
import { createFileTool } from './create_file.ts'
import { editFileTool } from './edit_file.ts'
import { fetchTool } from './fetch.ts'
import { readFileTool } from './read_file.ts'
import { searchTool } from './search.ts'

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(searchTool)
  registry.register(createFileTool)
  registry.register(editFileTool)
  registry.register(bashTool)
  registry.register(fetchTool)
  return registry
}
