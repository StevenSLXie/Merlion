import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'

export const sleepTool: ToolDefinition = {
  name: 'sleep',
  description: 'Pause execution for a short duration (milliseconds).',
  parameters: {
    type: 'object',
    properties: {
      duration_ms: { type: 'integer' }
    },
    required: ['duration_ms']
  },
  concurrencySafe: true,
  async execute(input) {
    const durationMs = parsePositiveInt(input.duration_ms, 0, 0, 60_000)
    if (durationMs <= 0) {
      return { content: 'Invalid duration_ms: expected positive integer <= 60000.', isError: true }
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    return { content: `Slept for ${durationMs} ms`, isError: false }
  }
}
