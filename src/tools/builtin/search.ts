import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'

const MAX_LINES = 200

type CmdResult = { code: number; stdout: string; stderr: string; error?: Error }

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<CmdResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr, error })
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

function truncateLines(output: string, maxLines = MAX_LINES): string {
  const lines = output.split('\n').filter((line) => line.length > 0)
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n[...output truncated — use path or glob to narrow the search]`
}

export const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Search file contents with ripgrep. For code search.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      case_sensitive: { type: 'boolean' }
    },
    required: ['pattern']
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { content: 'Invalid pattern: expected non-empty string.', isError: true }
    }

    const rawPath = typeof input.path === 'string' && input.path.trim() !== '' ? input.path : '.'
    const targetPath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath)
    const glob = typeof input.glob === 'string' && input.glob.trim() !== '' ? input.glob : undefined
    const caseSensitive = input.case_sensitive === true

    const rgArgs = ['--line-number', '--no-heading', '--max-count=200']
    if (!caseSensitive) rgArgs.push('-i')
    if (glob) rgArgs.push('--glob', glob)
    rgArgs.push(pattern, targetPath)

    const rgResult = await runCommand('rg', rgArgs, ctx.cwd)

    if (!rgResult.error) {
      if (rgResult.code === 0) {
        return { content: truncateLines(rgResult.stdout), isError: false }
      }
      if (rgResult.code === 1) {
        return { content: '(no matches found)', isError: false }
      }
      return {
        content: `search failed with rg (exit ${rgResult.code}): ${rgResult.stderr || '(no stderr)'}`,
        isError: true
      }
    }

    const grepArgs = ['-rn', '--line-number', '--exclude-dir=node_modules']
    if (!caseSensitive) grepArgs.push('-i')
    grepArgs.push(pattern, targetPath)
    const grepResult = await runCommand('grep', grepArgs, ctx.cwd)

    if (grepResult.code === 0) {
      return {
        content: `${truncateLines(grepResult.stdout)}\n[fallback: grep used because rg is unavailable]`,
        isError: false
      }
    }
    if (grepResult.code === 1) {
      return { content: '(no matches found)', isError: false }
    }
    return {
      content: `search failed: ${grepResult.stderr || '(no stderr)'}`,
      isError: true
    }
  }
}

