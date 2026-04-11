import type { ToolDefinition } from '../types.js'
import { grepTool } from './grep.ts'

export const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Search file contents with ripgrep. For code search.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      case_sensitive: { type: 'boolean' },
      max_results: { type: 'integer' },
      head_limit: { type: 'integer' },
      offset: { type: 'integer' },
      output_mode: { type: 'string' }
    },
    required: ['pattern']
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { content: 'Invalid pattern: expected non-empty string.', isError: true }
    }

    const forwarded: Record<string, unknown> = {
      ...input,
      output_mode: input.output_mode ?? 'content',
      '-n': true
    }
    if (typeof input.case_sensitive === 'boolean' && typeof input['-i'] !== 'boolean') {
      forwarded['-i'] = input.case_sensitive !== true
    }
    if (typeof input.head_limit !== 'number' && typeof input.max_results === 'number') {
      forwarded.head_limit = input.max_results
    }
    return grepTool.execute(forwarded, ctx)
  }
}
