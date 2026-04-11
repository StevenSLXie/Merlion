import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const moveFileTool: ToolDefinition = {
  name: 'move_file',
  description: 'Move or rename a file/directory within workspace.',
  parameters: {
    type: 'object',
    properties: {
      from_path: { type: 'string' },
      to_path: { type: 'string' }
    },
    required: ['from_path', 'to_path']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const from = validateAndResolveWorkspacePath(ctx.cwd, input.from_path)
    if (!from.ok) return { content: from.error, isError: true }
    const to = validateAndResolveWorkspacePath(ctx.cwd, input.to_path)
    if (!to.ok) return { content: to.error, isError: true }

    const decision = await ctx.permissions?.ask('move_file', `Move: ${input.from_path} -> ${input.to_path}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    await mkdir(dirname(to.path), { recursive: true })
    try {
      await rename(from.path, to.path)
    } catch (error) {
      return { content: `Move failed: ${String(error)}`, isError: true }
    }
    return { content: `Moved ${from.path} -> ${to.path}`, isError: false }
  }
}
