import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

type TodoStatus = 'pending' | 'in_progress' | 'completed'
type TodoItem = { content: string; status: TodoStatus; activeForm?: string }

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const todos: TodoItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const content = (entry as Record<string, unknown>).content
    const status = (entry as Record<string, unknown>).status
    const activeForm = (entry as Record<string, unknown>).activeForm
    if (typeof content !== 'string' || content.trim() === '') return null
    if (!isTodoStatus(status)) return null
    if (activeForm !== undefined && typeof activeForm !== 'string') return null
    todos.push({
      content: content.trim(),
      status,
      ...(typeof activeForm === 'string' && activeForm.trim() !== '' ? { activeForm: activeForm.trim() } : {})
    })
  }
  return todos
}

function renderTodoSummary(todos: TodoItem[]): string {
  if (todos.length === 0) return '(empty todo list)'
  return todos
    .map((todo, idx) => `${idx + 1}. [${todo.status}] ${todo.content}${todo.activeForm ? ` (${todo.activeForm})` : ''}`)
    .join('\n')
}

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description: 'Manage todo checklist state for the current workspace/session.',
  parameters: {
    type: 'object',
    properties: {
      todos: { type: 'array' },
      item: { type: 'string' },
      checked: { type: 'boolean' },
      path: { type: 'string' }
    },
    required: []
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const parsedTodos = parseTodos(input.todos)
    if (Array.isArray(input.todos) && parsedTodos === null) {
      return {
        content: 'Invalid todos payload. Expected array of {content, status, activeForm?} with status in pending|in_progress|completed.',
        isError: true
      }
    }

    if (parsedTodos !== null) {
      const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path ?? '.merlion/todos.json')
      if (!validated.ok) return { content: validated.error, isError: true }

      const decision = await ctx.permissions?.ask('todo_write', `Update todo list: ${validated.path}`)
      if (decision === 'deny' || decision === undefined) {
        return { content: '[Permission denied]', isError: true }
      }

      let oldTodos: TodoItem[] = []
      try {
        const current = JSON.parse(await readFile(validated.path, 'utf8')) as Record<string, unknown>
        const fromFile = parseTodos(current.todos)
        if (fromFile) oldTodos = fromFile
      } catch {
        oldTodos = []
      }

      const allDone = parsedTodos.length > 0 && parsedTodos.every((todo) => todo.status === 'completed')
      const nextTodos = allDone ? [] : parsedTodos
      await mkdir(dirname(validated.path), { recursive: true })
      await writeFile(
        validated.path,
        `${JSON.stringify({ updatedAt: new Date().toISOString(), todos: nextTodos }, null, 2)}\n`,
        'utf8'
      )
      return {
        content: `Updated todo list ${oldTodos.length} -> ${nextTodos.length}\n${renderTodoSummary(nextTodos)}`,
        isError: false
      }
    }

    const item = input.item
    if (typeof item !== 'string' || item.trim() === '') {
      return { content: 'Invalid input: provide todos[] or item.', isError: true }
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
