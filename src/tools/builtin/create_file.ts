import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

function countLines(content: string): number {
  if (content.length === 0) return 0
  const lines = content.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export const createFileTool: ToolDefinition = {
  name: 'create_file',
  description: 'Create a new file with content. Fails if file already exists.',
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
    const pathInput = input.path
    const contentInput = input.content

    const validated = validateAndResolveWorkspacePath(ctx.cwd, pathInput)
    if (!validated.ok) return { content: validated.error, isError: true }
    if (typeof contentInput !== 'string') {
      return { content: 'Invalid content: expected string.', isError: true }
    }

    const decision = await ctx.permissions?.ask('create_file', `Create: ${pathInput}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    try {
      await stat(validated.path)
      return {
        content: 'File already exists. Use edit_file to modify existing files.',
        isError: true
      }
    } catch {
      // expected when file does not exist
    }

    await mkdir(dirname(validated.path), { recursive: true })
    await writeFile(validated.path, contentInput, 'utf8')

    return {
      content: `Created ${validated.path} (${countLines(contentInput)} lines, ${contentInput.length} chars)`,
      isError: false
    }
  }
}
