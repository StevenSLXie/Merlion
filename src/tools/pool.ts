import type { ToolDefinition } from './types.js'
import { getBuiltinToolCatalog } from './catalog.ts'

export type ToolPoolMode = 'default' | 'wechat'

export interface ToolPoolOptions {
  mode?: ToolPoolMode
  includeNames?: string[]
  excludeNames?: string[]
}

const WECHAT_EXCLUDED_TOOLS = new Set([
  'config',
  'config_get',
  'config_set',
])

function normalizeNameList(values?: string[]): Set<string> | null {
  if (!values || values.length === 0) return null
  const out = new Set<string>()
  for (const value of values) {
    const normalized = value.trim()
    if (normalized !== '') out.add(normalized)
  }
  return out.size > 0 ? out : null
}

function passesMode(tool: ToolDefinition, mode: ToolPoolMode): boolean {
  if (mode === 'wechat') {
    return !WECHAT_EXCLUDED_TOOLS.has(tool.name)
  }
  return true
}

export function assembleToolPool(options?: ToolPoolOptions): ToolDefinition[] {
  const mode = options?.mode ?? 'default'
  const include = normalizeNameList(options?.includeNames)
  const exclude = normalizeNameList(options?.excludeNames)

  return getBuiltinToolCatalog().filter((tool) => {
    if (!passesMode(tool, mode)) return false
    if (include && !include.has(tool.name)) return false
    if (exclude && exclude.has(tool.name)) return false
    return true
  })
}
