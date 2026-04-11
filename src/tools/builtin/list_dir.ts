import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { parsePositiveInt, validateAndResolveWorkspacePath } from './fs_common.ts'

interface QueueItem {
  abs: string
  rel: string
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List files and directories under a path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
      max_entries: { type: 'integer' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path ?? '.')
    if (!validated.ok) return { content: validated.error, isError: true }
    const recursive = input.recursive === true
    const maxEntries = parsePositiveInt(input.max_entries, 200, 1, 2000)
    const root = resolve(ctx.cwd)
    const baseAbs = validated.path
    const baseRel = relative(root, baseAbs) || '.'
    const queue: QueueItem[] = [{ abs: baseAbs, rel: baseRel }]
    const lines: string[] = []

    while (queue.length > 0 && lines.length < maxEntries) {
      const next = queue.shift()!
      let entries
      try {
        entries = await readdir(next.abs, { withFileTypes: true })
      } catch (error) {
        return { content: `Failed to read directory: ${String(error)}`, isError: true }
      }

      for (const entry of entries) {
        if (lines.length >= maxEntries) break
        const childRel = next.rel === '.' ? entry.name : `${next.rel}/${entry.name}`
        const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file'
        lines.push(`${type}\t${childRel}`)
        if (recursive && entry.isDirectory()) {
          queue.push({ abs: join(next.abs, entry.name), rel: childRel })
        }
      }
    }

    if (lines.length === 0) return { content: '(empty directory)', isError: false }
    if (lines.length >= maxEntries) {
      lines.push(`[truncated to ${maxEntries} entries]`)
    }
    return { content: lines.join('\n'), isError: false }
  }
}
