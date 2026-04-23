import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { authorizeMutation, resolveMutationTargetPath } from './fs_common.ts'

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
    const from = await resolveMutationTargetPath(ctx.cwd, input.from_path)
    if (!from.ok) return { content: from.error, isError: true }
    const to = await resolveMutationTargetPath(ctx.cwd, input.to_path)
    if (!to.ok) return { content: to.error, isError: true }
    const fromAuthorization = await authorizeMutation(
      ctx,
      'move_file',
      from.path,
      `Move source: ${input.from_path} -> ${input.to_path}`,
    )
    if (!fromAuthorization.ok) return { content: fromAuthorization.error, isError: true }
    const toAuthorization = await authorizeMutation(
      ctx,
      'move_file',
      to.path,
      `Move destination: ${input.from_path} -> ${input.to_path}`,
    )
    if (!toAuthorization.ok) return { content: toAuthorization.error, isError: true }

    await mkdir(dirname(to.path), { recursive: true })
    try {
      await rename(from.path, to.path)
    } catch (error) {
      return { content: `Move failed: ${String(error)}`, isError: true }
    }
    return { content: `Moved ${from.path} -> ${to.path}`, isError: false }
  }
}
