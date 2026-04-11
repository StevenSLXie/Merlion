import { mkdir } from 'node:fs/promises'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const mkdirTool: ToolDefinition = {
  name: 'mkdir',
  description: 'Create a directory recursively.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path)
    if (!validated.ok) return { content: validated.error, isError: true }

    const decision = await ctx.permissions?.ask('mkdir', `Create directory: ${input.path}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    await mkdir(validated.path, { recursive: true })
    return { content: `Created directory ${validated.path}`, isError: false }
  }
}
