import type { ToolDefinition } from './types.js'
import { getBuiltinToolCatalog } from './catalog.ts'
import type { CapabilityProfileName } from '../runtime/task_state.ts'
import { allowedSubagentRolesForProfile } from '../runtime/task_state.ts'

export type ToolPoolMode = 'default' | 'wechat'

export interface ToolPoolOptions {
  mode?: ToolPoolMode
  profile?: CapabilityProfileName
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
    if (WECHAT_EXCLUDED_TOOLS.has(tool.name)) return false
    if (tool.requiresUserInteraction === true) return false
  }
  return true
}

function toolNamesForProfile(profile: CapabilityProfileName): Set<string> {
  switch (profile) {
    case 'readonly_question':
      return new Set([
        'read_file',
        'list_dir',
        'stat_path',
        'search',
        'grep',
        'glob',
        'git_status',
        'git_diff',
        'git_log',
        'fetch',
        'lsp',
        'tool_search',
      ])
    case 'readonly_analysis':
    case 'readonly_review':
      return new Set([
        'read_file',
        'list_dir',
        'stat_path',
        'search',
        'grep',
        'glob',
        'git_status',
        'git_diff',
        'git_log',
        'fetch',
        'lsp',
        'tool_search',
        'list_scripts',
        'spawn_agent',
      ])
    case 'verification_readonly':
      return new Set([
        'read_file',
        'list_dir',
        'stat_path',
        'search',
        'grep',
        'glob',
        'git_status',
        'git_diff',
        'git_log',
        'fetch',
        'lsp',
        'tool_search',
        'list_scripts',
        'spawn_agent',
        'bash',
        'run_script',
      ])
    case 'meta_control':
      return new Set([
        'read_file',
        'list_dir',
        'stat_path',
        'search',
        'grep',
        'glob',
        'git_status',
        'git_diff',
        'tool_search',
      ])
    case 'implementation_scoped':
    default:
      return new Set(getBuiltinToolCatalog().map((tool) => tool.name))
  }
}

function wrapToolForProfile(tool: ToolDefinition, profile: CapabilityProfileName): ToolDefinition {
  if (tool.name === 'spawn_agent' && profile !== 'implementation_scoped') {
    const allowedRoles = allowedSubagentRolesForProfile(profile)
    return {
      ...tool,
      isReadOnly: true,
      async execute(input, ctx) {
        const role = typeof input.role === 'string' ? input.role.trim() : ''
        if (!allowedRoles.has(role as never)) {
          return {
            content: `[Denied by capability profile ${profile}] spawn_agent role "${role}" is not allowed.`,
            isError: true,
          }
        }
        return await tool.execute(input, ctx)
      },
    }
  }

  if ((tool.name === 'bash' || tool.name === 'run_script') && profile !== 'implementation_scoped') {
    return { ...tool, isReadOnly: true }
  }

  return tool
}

export function applyCapabilityProfile(tools: ToolDefinition[], profile?: CapabilityProfileName): ToolDefinition[] {
  if (!profile) return [...tools]
  if (profile === 'implementation_scoped') return [...tools]
  const allowed = toolNamesForProfile(profile)
  return tools
    .filter((tool) => allowed.has(tool.name) || tool.isReadOnly === true)
    .map((tool) => wrapToolForProfile(tool, profile))
}

export function assembleToolPool(options?: ToolPoolOptions): ToolDefinition[] {
  const mode = options?.mode ?? 'default'
  const profile = options?.profile
  const include = normalizeNameList(options?.includeNames)
  const exclude = normalizeNameList(options?.excludeNames)

  return applyCapabilityProfile(getBuiltinToolCatalog(), profile).filter((tool) => {
    if (!passesMode(tool, mode)) return false
    if (include && !include.has(tool.name)) return false
    if (exclude && exclude.has(tool.name)) return false
    return true
  })
}
