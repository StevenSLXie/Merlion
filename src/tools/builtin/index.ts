import { ToolRegistry } from '../registry.ts'
import type { ToolDefinition } from '../types.js'
import { assembleToolPool, type ToolPoolOptions } from '../pool.ts'

export function buildRegistryFromPool(tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) {
    registry.register(tool)
  }
  return registry
}

export function buildDefaultRegistry(options?: ToolPoolOptions): ToolRegistry {
  return buildRegistryFromPool(assembleToolPool(options))
}
