import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const statPathTool: ToolDefinition = {
  name: 'stat_path',
  description: 'Return file/directory metadata.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path']
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path)
    if (!validated.ok) return { content: validated.error, isError: true }
    let st
    try {
      st = await stat(validated.path)
    } catch {
      return { content: `Path not found: ${input.path}`, isError: true }
    }

    const root = resolve(ctx.cwd)
    const rel = relative(root, validated.path) || '.'
    const type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'
    return {
      content: [
        `path: ${validated.path}`,
        `relative: ${rel}`,
        `type: ${type}`,
        `size: ${st.size}`,
        `mtime: ${st.mtime.toISOString()}`,
        `mode: ${st.mode.toString(8)}`
      ].join('\n'),
      isError: false
    }
  }
}
