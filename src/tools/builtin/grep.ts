import { resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { parsePositiveInt, validateAndResolveWorkspacePath } from './fs_common.ts'
import { runProcess } from './process_common.ts'

function truncateLines(output: string, maxLines: number): string {
  const lines = output.split('\n').filter((line) => line !== '')
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n[truncated to ${maxLines} lines]`
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents with regex pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      case_sensitive: { type: 'boolean' },
      context_lines: { type: 'integer' },
      max_results: { type: 'integer' }
    },
    required: ['pattern']
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { content: 'Invalid pattern: expected non-empty string.', isError: true }
    }

    const validated = validateAndResolveWorkspacePath(ctx.cwd, input.path ?? '.')
    if (!validated.ok) return { content: validated.error, isError: true }
    const targetPath = validated.path
    const glob = typeof input.glob === 'string' && input.glob.trim() !== '' ? input.glob.trim() : undefined
    const context = parsePositiveInt(input.context_lines, 0, 0, 8)
    const maxResults = parsePositiveInt(input.max_results, 200, 1, 2000)
    const caseSensitive = input.case_sensitive === true

    const rgArgs = ['--line-number', '--no-heading', '--max-count', String(maxResults)]
    if (!caseSensitive) rgArgs.push('-i')
    if (context > 0) rgArgs.push('-C', String(context))
    if (glob) rgArgs.push('--glob', glob)
    rgArgs.push(pattern, targetPath)
    const rg = await runProcess('rg', rgArgs, ctx.cwd, { timeoutMs: 20_000 })

    if (rg.exitCode === 0) {
      return { content: truncateLines(rg.stdout, maxResults), isError: false }
    }
    if (rg.exitCode === 1) {
      return { content: '(no matches found)', isError: false }
    }

    const grepArgs = ['-rn', '--line-number']
    if (!caseSensitive) grepArgs.push('-i')
    grepArgs.push(pattern, resolve(targetPath))
    const grep = await runProcess('grep', grepArgs, ctx.cwd, { timeoutMs: 20_000 })
    if (grep.exitCode === 0) {
      return { content: `${truncateLines(grep.stdout, maxResults)}\n[fallback: grep used]`, isError: false }
    }
    if (grep.exitCode === 1) {
      return { content: '(no matches found)', isError: false }
    }
    return { content: `grep failed: ${grep.stderr || '(no stderr)'}`, isError: true }
  }
}
