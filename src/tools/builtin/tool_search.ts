import { getRequiredParameterNames, summarizeModelGuidance } from '../model_guidance.ts'
import type { ToolDefinition, ToolSummary } from '../types.js'

function parseMaxResults(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5
  const parsed = Math.floor(value)
  if (parsed < 1) return 1
  if (parsed > 50) return 50
  return parsed
}

function scoreTool(
  query: string,
  name: string,
  description: string,
  searchHint?: string,
  modelGuidance?: string,
): number {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const d = description.toLowerCase()
  const h = searchHint?.toLowerCase() ?? ''
  const g = modelGuidance?.toLowerCase() ?? ''
  if (n === q) return 1_000
  let score = 0
  if (n.includes(q)) score += 100
  if (d.includes(q)) score += 40
  if (h.includes(q)) score += 60
  if (g.includes(q)) score += 30
  for (const term of q.split(/\s+/).filter((t) => t !== '')) {
    if (n.includes(term)) score += 10
    if (d.includes(term)) score += 3
    if (h.includes(term)) score += 5
    if (g.includes(term)) score += 3
  }
  return score
}

function formatToolListLine(tool: ToolSummary): string {
  const guidance = summarizeModelGuidance(tool.modelGuidance, 120)
  return guidance === ''
    ? `${tool.name}\t${tool.description}`
    : `${tool.name}\t${tool.description} | ${guidance}`
}

function formatSelectedTool(tool: ToolSummary): string {
  const lines = [
    `name: ${tool.name}`,
    `description: ${tool.description}`,
    `required_args: ${(() => {
      const required = getRequiredParameterNames(tool)
      return required.length > 0 ? required.join(', ') : '(none)'
    })()}`,
  ]

  if (tool.modelGuidance && tool.modelGuidance.trim() !== '') {
    lines.push('guidance:')
    for (const line of tool.modelGuidance.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
      lines.push(line.startsWith('-') ? line : `- ${line}`)
    }
  }

  const examples = Array.isArray(tool.modelExamples)
    ? tool.modelExamples.map((example) => example.trim()).filter((example) => example !== '').slice(0, 2)
    : []
  if (examples.length > 0) {
    lines.push('examples:')
    for (const example of examples) {
      lines.push(`- ${example}`)
    }
  }

  return lines.join('\n')
}

export const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: 'List available tools, optionally filtered by query.',
  modelGuidance: [
    '- Use this when you are unsure which tool fits the task or which parameters are required.',
    '- Query by capability, like "find files", "read file", or "run tests".',
    '- Use select:<tool_name> to inspect one tool in detail before calling it.',
    '- Prefer a dedicated tool over bash when an existing tool matches the job.'
  ].join('\n'),
  modelExamples: [
    '{"query":"select:edit_file"}'
  ],
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
      return { content: formatSelectedTool(exact), isError: false }
    }

    const filtered = query === ''
      ? tools
      : tools
        .map((tool) => ({
          tool,
          score: scoreTool(query, tool.name, tool.description, tool.searchHint, tool.modelGuidance)
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .map((item) => item.tool)
    if (filtered.length === 0) return { content: '(no matching tools)', isError: false }

    const shown = filtered.slice(0, maxResults)
    const truncated = filtered.length > shown.length
    return {
      content: shown
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => formatToolListLine(tool))
        .join('\n') + (truncated ? '\n(Results are truncated. Use a narrower query or increase max_results.)' : ''),
      isError: false
    }
  }
}
