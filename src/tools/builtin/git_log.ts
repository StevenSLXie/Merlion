import { relative } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { enforceReadDiscoveryPolicy, parsePositiveInt, resolveReadTargetPath } from './fs_common.ts'
import { runProcess } from './process_common.ts'

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent git commit history.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      path: { type: 'string' },
    }
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const limit = parsePositiveInt(input.limit, 20, 1, 200)
    const args = ['log', '--oneline', '--decorate', `-${limit}`]
    if ((ctx.sandbox?.policy?.denyRead.length ?? 0) > 0 && (typeof input.path !== 'string' || input.path.trim() === '')) {
      return {
        content: 'git_log requires an explicit allowed path when sandbox deny-read policy is active.',
        isError: true,
      }
    }
    if (typeof input.path === 'string' && input.path.trim() !== '') {
      const validated = await resolveReadTargetPath(ctx.cwd, input.path.trim())
      if (!validated.ok) return { content: validated.error, isError: true }
      const readPolicy = enforceReadDiscoveryPolicy(ctx, validated.path)
      if (!readPolicy.ok) return { content: readPolicy.error, isError: true }
      args.push('--', relative(ctx.cwd, validated.path) || '.')
    }
    const result = await runProcess('git', args, ctx.cwd, { timeoutMs: 15_000 })
    if (result.timedOut) return { content: '[git log timed out]', isError: true }
    if (result.exitCode !== 0) return { content: result.stderr || 'git log failed', isError: true }
    const text = result.stdout.trim()
    return { content: text === '' ? '(no commits)' : text, isError: false }
  }
}
