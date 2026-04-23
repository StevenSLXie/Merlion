import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { authorizeMutation, resolveMutationTargetPath } from './fs_common.ts'

export const appendFileTool: ToolDefinition = {
  name: 'append_file',
  description: 'Append text to an existing file (creates file if missing).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const validated = await resolveMutationTargetPath(ctx.cwd, input.path)
    if (!validated.ok) return { content: validated.error, isError: true }
    if (typeof input.content !== 'string') {
      return { content: 'Invalid content: expected string.', isError: true }
    }
    const authorization = await authorizeMutation(ctx, 'append_file', validated.path, `Append: ${input.path}`)
    if (!authorization.ok) return { content: authorization.error, isError: true }

    await mkdir(dirname(validated.path), { recursive: true })
    await appendFile(validated.path, input.content, 'utf8')
    return { content: `Appended ${input.content.length} chars to ${validated.path}`, isError: false }
  }
}
