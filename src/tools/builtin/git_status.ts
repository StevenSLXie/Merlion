import type { ToolDefinition } from '../types.js'
import { runProcess } from './process_common.ts'

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show git working tree status.',
  parameters: {
    type: 'object',
    properties: {
      short: { type: 'boolean' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const short = input.short !== false
    const args = ['status']
    if (short) args.push('--short')
    const result = await runProcess('git', args, ctx.cwd, { timeoutMs: 15_000 })
    if (result.timedOut) return { content: '[git status timed out]', isError: true }
    if (result.exitCode !== 0) {
      return { content: result.stderr || 'git status failed', isError: true }
    }
    const text = result.stdout.trim()
    return { content: text === '' ? '(clean working tree)' : text, isError: false }
  }
}
