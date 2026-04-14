import type { ToolDefinition } from '../types.js'

function parseMaxResults(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5
  const parsed = Math.floor(value)
  if (parsed < 1) return 1
  if (parsed > 50) return 50
  return parsed
}

function scoreTool(query: string, name: string, description: string, searchHint?: string): number {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const d = description.toLowerCase()
  const h = searchHint?.toLowerCase() ?? ''
  if (n === q) return 1_000
  let score = 0
  if (n.includes(q)) score += 100
  if (d.includes(q)) score += 40
  if (h.includes(q)) score += 60
  for (const term of q.split(/\s+/).filter((t) => t !== '')) {
    if (n.includes(term)) score += 10
    if (d.includes(term)) score += 3
    if (h.includes(term)) score += 5
  }
  return score
}

export const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: 'List available tools, optionally filtered by query.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'integer' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const tools = ctx.listTools?.() ?? []
    if (tools.length === 0) return { content: '(no tools available)', isError: false }
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const maxResults = parseMaxResults(input.max_results)

    if (query.startsWith('select:')) {
      const selected = query.slice('select:'.length).trim()
      if (selected === '') return { content: 'Invalid select query. Use select:<tool_name>.', isError: true }
      const exact = tools.find((tool) => tool.name.toLowerCase() === selected)
      if (!exact) return { content: `(no matching tools for ${selected})`, isError: false }
      return { content: `${exact.name}\t${exact.description}`, isError: false }
    }

    const filtered = query === ''
      ? tools
      : tools
        .map((tool) => ({ tool, score: scoreTool(query, tool.name, tool.description, tool.searchHint) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .map((item) => item.tool)
    if (filtered.length === 0) return { content: '(no matching tools)', isError: false }

    const shown = filtered.slice(0, maxResults)
    const truncated = filtered.length > shown.length
    return {
      content: shown
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => `${tool.name}\t${tool.description}`)
        .join('\n') + (truncated ? '\n(Results are truncated. Use a narrower query or increase max_results.)' : ''),
      isError: false
    }
  }
}
