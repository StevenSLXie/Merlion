import type { ToolDefinition, ToolSummary } from './types.js'

const MODEL_TOOL_DESCRIPTION_LIMIT = 1_400

interface ModelGuidanceShape {
  description: string
  modelGuidance?: string
  modelExamples?: string[]
  guidancePriority?: 'normal' | 'critical'
}

function normalizeGuidanceText(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

function trimToLimit(value: string, limit: number): string {
  if (value.length <= limit) return value
  const truncated = value.slice(0, Math.max(0, limit - 1)).trimEnd()
  return `${truncated}…`
}

export function getRequiredParameterNames(tool: Pick<ToolDefinition, 'parameters'> | ToolSummary): string[] {
  if ('requiredParameters' in tool && Array.isArray(tool.requiredParameters)) {
    return tool.requiredParameters.filter((value) => typeof value === 'string' && value.trim() !== '')
  }
  if ('parameters' in tool && Array.isArray(tool.parameters.required)) {
    return [...tool.parameters.required]
  }
  return []
}

export function summarizeModelGuidance(guidance?: string, maxLength = 180): string {
  if (typeof guidance !== 'string') return ''
  const normalized = normalizeGuidanceText(guidance).replace(/\n+/g, ' ')
  if (normalized === '') return ''
  return trimToLimit(normalized, maxLength)
}

export function buildModelToolDescription(tool: ModelGuidanceShape): string {
  const parts: string[] = [tool.description.trim()]
  const normalizedGuidance = typeof tool.modelGuidance === 'string'
    ? normalizeGuidanceText(tool.modelGuidance)
    : ''
  const examples = Array.isArray(tool.modelExamples)
    ? tool.modelExamples
      .map((example) => example.trim())
      .filter((example) => example !== '')
      .slice(0, 2)
    : []

  if (normalizedGuidance !== '') {
    const prefix = tool.guidancePriority === 'critical' ? 'Critical guidance:' : 'Usage guidance:'
    parts.push(`${prefix}\n${normalizedGuidance}`)
  }

  if (examples.length > 0) {
    parts.push(`Examples:\n${examples.map((example) => `- ${example}`).join('\n')}`)
  }

  return trimToLimit(parts.filter((part) => part !== '').join('\n\n'), MODEL_TOOL_DESCRIPTION_LIMIT)
}
