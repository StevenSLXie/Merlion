import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description: 'Append a todo item to a markdown checklist file.',
  parameters: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      checked: { type: 'boolean' },
      path: { type: 'string' }
    },
    required: ['item']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const item = input.item
    if (typeof item !== 'string' || item.trim() === '') {
      return { content: 'Invalid item: expected non-empty string.', isError: true }
    }

    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path ?? 'docs/todo.md')
    if (!validated.ok) return { content: validated.error, isError: true }
    const checked = input.checked === true
    const line = `- [${checked ? 'x' : ' '}] ${item.trim()}`

    const decision = await ctx.permissions?.ask('todo_write', `Append todo: ${validated.path}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    await mkdir(dirname(validated.path), { recursive: true })
    let content = ''
    try {
      content = await readFile(validated.path, 'utf8')
    } catch {
      content = '# TODO\n\n'
    }
    const prefix = content.endsWith('\n') ? '' : '\n'
    await writeFile(validated.path, `${content}${prefix}${line}\n`, 'utf8')
    return { content: `Appended todo item to ${validated.path}`, isError: false }
  }
}
