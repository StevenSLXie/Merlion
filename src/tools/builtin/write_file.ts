import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write file content (create or overwrite).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      file_path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['content']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const rawPath = typeof input.path === 'string' ? input.path : input.file_path
    const validated = validateAndResolveWorkspacePath(ctx.cwd, rawPath)
    if (!validated.ok) return { content: validated.error, isError: true }
    if (typeof input.content !== 'string') {
      return { content: 'Invalid content: expected string.', isError: true }
    }

    const decision = await ctx.permissions?.ask('write_file', `Write: ${String(rawPath)}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    await mkdir(dirname(validated.path), { recursive: true })
    await writeFile(validated.path, input.content, 'utf8')
    return { content: `Wrote ${validated.path} (${input.content.length} chars)`, isError: false }
  }
}
