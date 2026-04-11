import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'
import { runProcess } from './process_common.ts'

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n[diff truncated to ${maxLines} lines]`
}

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show git diff (staged or unstaged).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      staged: { type: 'boolean' },
      max_lines: { type: 'integer' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const args = ['diff']
    if (input.staged === true) args.push('--staged')
    if (typeof input.path === 'string' && input.path.trim() !== '') {
      args.push('--', input.path.trim())
    }
    const maxLines = parsePositiveInt(input.max_lines, 400, 20, 4000)
    const result = await runProcess('git', args, ctx.cwd, { timeoutMs: 20_000 })
    if (result.timedOut) return { content: '[git diff timed out]', isError: true }
    if (result.exitCode !== 0) {
      return { content: result.stderr || 'git diff failed', isError: true }
    }
    const text = result.stdout.trim()
    if (text === '') return { content: '(no diff)', isError: false }
    return { content: truncateLines(text, maxLines), isError: false }
  }
}
