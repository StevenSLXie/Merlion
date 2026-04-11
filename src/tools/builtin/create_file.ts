import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'

function isWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = resolve(workspaceRoot)
  const target = resolve(candidatePath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

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

    if (typeof pathInput !== 'string' || pathInput.trim() === '') {
      return { content: 'Invalid path: expected non-empty string.', isError: true }
    }
    if (typeof contentInput !== 'string') {
      return { content: 'Invalid content: expected string.', isError: true }
    }

    const decision = await ctx.permissions?.ask('create_file', `Create: ${pathInput}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    const resolvedPath = isAbsolute(pathInput) ? resolve(pathInput) : resolve(ctx.cwd, pathInput)
    if (!isWithinWorkspace(ctx.cwd, resolvedPath)) {
      return { content: 'Path is outside the workspace root and cannot be modified.', isError: true }
    }

    try {
      await stat(resolvedPath)
      return {
        content: 'File already exists. Use edit_file to modify existing files.',
        isError: true
      }
    } catch {
      // expected when file does not exist
    }

    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, contentInput, 'utf8')

    return {
      content: `Created ${resolvedPath} (${countLines(contentInput)} lines, ${contentInput.length} chars)`,
      isError: false
    }
  }
}

