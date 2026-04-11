export function formatTurnStartEvent(event: { turn: number }): string {
  return `[turn ${event.turn}] requesting model...`
}

export function formatAssistantResponseEvent(event: {
  turn: number
  finish_reason: string
  tool_calls_count: number
}): string {
  if (event.finish_reason === 'tool_calls') {
    return `[turn ${event.turn}] assistant requested ${event.tool_calls_count} tool call(s)`
  }
  return `[turn ${event.turn}] assistant finish=${event.finish_reason}`
}

export function summarizeToolArguments(raw: string, maxLen = 80): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed)
    if (keys.length === 0) return ''
    const parts = keys.slice(0, 2).map((key) => {
      const value = parsed[key]
      if (typeof value === 'string') {
        const compact = value.replace(/\s+/g, ' ').trim()
        return `${key}=${compact.length > 28 ? `${compact.slice(0, 28)}...` : compact}`
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${String(value)}`
      }
      return `${key}=...`
    })
    const joined = parts.join(', ')
    return joined.length > maxLen ? `${joined.slice(0, maxLen)}...` : joined
  } catch {
    return ''
  }
}

export function formatToolStartEvent(event: {
  index: number
  total: number
  name: string
  summary?: string
}): string {
  const suffix = event.summary && event.summary.trim() !== '' ? ` (${event.summary})` : ''
  return `[tool ${event.index}/${event.total}] start ${event.name}${suffix}`
}

export function formatToolResultEvent(event: {
  index: number
  total: number
  name: string
  isError: boolean
  durationMs: number
}): string {
  const status = event.isError ? 'error' : 'ok'
  return `[tool ${event.index}/${event.total}] ${status} ${event.name} (${event.durationMs}ms)`
}
