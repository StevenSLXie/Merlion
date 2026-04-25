import type { ToolDefinition } from './types.js'

const ORDER_INSENSITIVE_SCHEMA_ARRAY_KEYS = new Set(['required', 'enum', 'type'])

type ComparableToolDefinition = {
  name: string
  description: string
  parameters: unknown
}

function schemaValueSortKey(value: unknown): string {
  if (value === null) return 'null:null'
  if (Array.isArray(value)) return `array:${JSON.stringify(value)}`
  if (typeof value === 'object') return `object:${JSON.stringify(value)}`
  return `${typeof value}:${JSON.stringify(value)}`
}

function canonicalizeSchemaValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalizeSchemaValue(entry))
    if (parentKey && ORDER_INSENSITIVE_SCHEMA_ARRAY_KEYS.has(parentKey)) {
      return [...items].sort((left, right) =>
        schemaValueSortKey(left).localeCompare(schemaValueSortKey(right))
      )
    }
    return items
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeSchemaValue((value as Record<string, unknown>)[key], key)
    }
    return out
  }
  return value
}

function compareToolDefinitions(left: ComparableToolDefinition, right: ComparableToolDefinition): number {
  const nameOrder = left.name.localeCompare(right.name)
  if (nameOrder !== 0) return nameOrder
  const descriptionOrder = left.description.localeCompare(right.description)
  if (descriptionOrder !== 0) return descriptionOrder
  return JSON.stringify(left.parameters).localeCompare(JSON.stringify(right.parameters))
}

export function canonicalizeToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    parameters: canonicalizeSchemaValue(tool.parameters) as ToolDefinition['parameters'],
  }
}

export function serializeToolSchema(
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>
): string {
  const canonicalTools = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalizeSchemaValue(tool.parameters),
    }))
    .sort(compareToolDefinitions)
  return JSON.stringify(canonicalTools)
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`)
    }
    this.tools.set(tool.name, canonicalizeToolDefinition(tool))
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).sort(compareToolDefinitions)
  }
}
