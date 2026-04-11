import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'
import { runProcess } from './process_common.ts'

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent git commit history.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer' }
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const limit = parsePositiveInt(input.limit, 20, 1, 200)
    const result = await runProcess(
      'git',
      ['log', '--oneline', '--decorate', `-${limit}`],
      ctx.cwd,
      { timeoutMs: 15_000 }
    )
    if (result.timedOut) return { content: '[git log timed out]', isError: true }
    if (result.exitCode !== 0) return { content: result.stderr || 'git log failed', isError: true }
    const text = result.stdout.trim()
    return { content: text === '' ? '(no commits)' : text, isError: false }
  }
}
