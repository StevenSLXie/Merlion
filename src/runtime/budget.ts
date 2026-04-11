export interface ToolResultBudgetOptions {
  maxChars?: number
  maxLines?: number
}

export interface BudgetedToolResult {
  content: string
  truncated: boolean
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  const value = Math.floor(n)
  return value > 0 ? value : undefined
}

export function resolveToolResultBudgetFromEnv(): Required<ToolResultBudgetOptions> {
  return {
    maxChars: parsePositiveInt(process.env.MERLION_TOOL_RESULT_MAX_CHARS) ?? 6000,
    maxLines: parsePositiveInt(process.env.MERLION_TOOL_RESULT_MAX_LINES) ?? 220,
  }
}

export function applyToolResultBudget(
  content: string,
  options?: ToolResultBudgetOptions
): BudgetedToolResult {
  const maxChars = Math.max(200, options?.maxChars ?? 6000)
  const maxLines = Math.max(20, options?.maxLines ?? 220)
  let output = content
  let truncated = false

  const lines = output.split('\n')
  if (lines.length > maxLines) {
    const headLines = Math.max(1, Math.floor(maxLines * 0.55))
    const tailLines = Math.max(1, maxLines - headLines)
    output = [
      ...lines.slice(0, headLines),
      `[...truncated ${lines.length - headLines - tailLines} lines...]`,
      ...lines.slice(-tailLines),
    ].join('\n')
    truncated = true
  }

  if (output.length > maxChars) {
    const headChars = Math.max(80, Math.floor(maxChars * 0.58))
    const tailChars = Math.max(80, maxChars - headChars)
    output =
      output.slice(0, headChars) +
      `\n[...truncated ${output.length - headChars - tailChars} chars...]\n` +
      output.slice(-tailChars)
    truncated = true
  }

  return { content: output, truncated }
}
