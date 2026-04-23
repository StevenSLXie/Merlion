import { cp, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { authorizeMutation, enforceReadPolicy, resolveMutationTargetPath, resolveReadTargetPath } from './fs_common.ts'

export const copyFileTool: ToolDefinition = {
  name: 'copy_file',
  description: 'Copy a file (or directory when recursive=true) within workspace.',
  parameters: {
    type: 'object',
    properties: {
      from_path: { type: 'string' },
      to_path: { type: 'string' },
      recursive: { type: 'boolean' }
    },
    required: ['from_path', 'to_path']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const from = await resolveReadTargetPath(ctx.cwd, input.from_path)
    if (!from.ok) return { content: from.error, isError: true }
    const fromReadPolicy = enforceReadPolicy(ctx, from.path)
    if (!fromReadPolicy.ok) return { content: fromReadPolicy.error, isError: true }
    const to = await resolveMutationTargetPath(ctx.cwd, input.to_path)
    if (!to.ok) return { content: to.error, isError: true }
    const recursive = input.recursive === true
    const authorization = await authorizeMutation(
      ctx,
      'copy_file',
      to.path,
      `Copy: ${input.from_path} -> ${input.to_path}`,
    )
    if (!authorization.ok) return { content: authorization.error, isError: true }

    await mkdir(dirname(to.path), { recursive: true })
    try {
      await cp(from.path, to.path, { recursive })
    } catch (error) {
      return { content: `Copy failed: ${String(error)}`, isError: true }
    }
    return { content: `Copied ${from.path} -> ${to.path}`, isError: false }
  }
}
