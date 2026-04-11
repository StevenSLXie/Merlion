import { rm, stat } from 'node:fs/promises'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file or directory (recursive delete for directories requires recursive=true).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' }
    },
    required: ['path']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path)
    if (!validated.ok) return { content: validated.error, isError: true }
    const recursive = input.recursive === true

    const decision = await ctx.permissions?.ask('delete_file', `Delete: ${input.path}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    let fileStat
    try {
      fileStat = await stat(validated.path)
    } catch {
      return { content: `Path not found: ${input.path}`, isError: true }
    }

    if (fileStat.isDirectory() && !recursive) {
      return { content: 'Target is a directory. Set recursive=true to delete directories.', isError: true }
    }

    await rm(validated.path, { recursive, force: false })
    return { content: `Deleted ${validated.path}`, isError: false }
  }
}
