import type { ToolDefinition } from '../types.js'
import { resolve } from 'node:path'
import type { ResolvedSandboxPolicy } from '../../sandbox/policy.ts'
import { isPathReadDenied } from '../../sandbox/policy.ts'
import { runProcess } from './process_common.ts'

function parseStatusPaths(line: string): string[] {
  const payload = line.slice(3).trim()
  if (payload === '') return []
  if (payload.includes(' -> ')) {
    return payload.split(' -> ').map((value) => value.trim()).filter((value) => value !== '')
  }
  return [payload]
}

function filterShortStatusOutput(cwd: string, output: string, denyRead: string[]): string {
  if (denyRead.length === 0) return output
  const policy: ResolvedSandboxPolicy = {
    mode: 'workspace-write',
    approvalPolicy: 'never',
    networkMode: 'off',
    cwd,
    writableRoots: [cwd],
    denyRead,
    denyWrite: [],
  }
  return output
    .split('\n')
    .filter((line) => {
      if (line.trim() === '') return false
      const paths = parseStatusPaths(line)
      return !paths.some((entryPath) => isPathReadDenied(policy, resolve(cwd, entryPath)))
    })
    .join('\n')
}

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
    if (!short && (ctx.sandbox?.policy?.denyRead.length ?? 0) > 0) {
      return {
        content: 'git_status with short=false is unavailable when sandbox deny-read policy is active.',
        isError: true,
      }
    }
    const args = ['status']
    if (short) args.push('--short')
    const result = await runProcess('git', args, ctx.cwd, { timeoutMs: 15_000 })
    if (result.timedOut) return { content: '[git status timed out]', isError: true }
    if (result.exitCode !== 0) {
      return { content: result.stderr || 'git status failed', isError: true }
    }
    const text = (short
      ? filterShortStatusOutput(ctx.cwd, result.stdout, ctx.sandbox?.policy?.denyRead ?? [])
      : result.stdout).trim()
    return { content: text === '' ? '(clean working tree)' : text, isError: false }
  }
}
