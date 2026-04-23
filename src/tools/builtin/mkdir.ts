import { mkdir } from 'node:fs/promises'

import type { ToolDefinition } from '../types.js'
import { authorizeMutation, resolveMutationTargetPath } from './fs_common.ts'

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
    const validated = await resolveMutationTargetPath(ctx.cwd, input.path)
    if (!validated.ok) return { content: validated.error, isError: true }
    const authorization = await authorizeMutation(ctx, 'mkdir', validated.path, `Create directory: ${input.path}`)
    if (!authorization.ok) return { content: authorization.error, isError: true }

    await mkdir(validated.path, { recursive: true })
    return { content: `Created directory ${validated.path}`, isError: false }
  }
}
