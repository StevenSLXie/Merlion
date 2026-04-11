import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'

export const sleepTool: ToolDefinition = {
  name: 'sleep',
  description: 'Pause execution for a short duration.',
  parameters: {
    type: 'object',
    properties: {
      duration_ms: { type: 'integer' },
      duration_seconds: { type: 'integer' }
    },
    required: []
  },
  concurrencySafe: true,
  async execute(input) {
    const msFromSeconds = typeof input.duration_seconds === 'number'
      ? parsePositiveInt(input.duration_seconds, 0, 0, 300) * 1000
      : 0
    const durationMs = parsePositiveInt(input.duration_ms, msFromSeconds || 1_000, 1, 300_000)
    if (durationMs <= 0) {
      return { content: 'Invalid duration. Use duration_ms (1..300000) or duration_seconds (1..300).', isError: true }
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    return { content: `Slept for ${durationMs} ms`, isError: false }
  }
}
