import type { ToolDefinition } from '../types.js'

export const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: 'List available tools, optionally filtered by query.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const tools = ctx.listTools?.() ?? []
    if (tools.length === 0) return { content: '(no tools available)', isError: false }
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const filtered = query === ''
      ? tools
      : tools.filter((tool) => (
          tool.name.toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query)
        ))
    if (filtered.length === 0) return { content: '(no matching tools)', isError: false }
    return {
      content: filtered
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => `${tool.name}\t${tool.description}`)
        .join('\n'),
      isError: false
    }
  }
}
