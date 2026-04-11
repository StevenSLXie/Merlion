import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { parsePositiveInt, validateAndResolveWorkspacePath } from './fs_common.ts'
import { runProcess } from './process_common.ts'

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/§§DOUBLESTAR§§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function fallbackGlob(baseAbs: string, baseRel: string, pattern: string, limit: number): Promise<string[]> {
  const regex = globToRegExp(pattern)
  const out: string[] = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: baseAbs, rel: baseRel }]

  while (queue.length > 0 && out.length < limit) {
    const next = queue.shift()!
    const entries = await readdir(next.abs, { withFileTypes: true })
    for (const entry of entries) {
      if (out.length >= limit) break
      const childRel = next.rel === '.' ? entry.name : `${next.rel}/${entry.name}`
      if (entry.isDirectory()) {
        queue.push({ abs: join(next.abs, entry.name), rel: childRel })
      } else if (entry.isFile() && regex.test(childRel)) {
        out.push(childRel)
      }
    }
  }
  return out
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'List files matching a glob pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
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
    const maxResults = parsePositiveInt(input.max_results, 300, 1, 2000)
    const baseAbs = validated.path
    const baseRel = relative(resolve(ctx.cwd), baseAbs) || '.'

    const rg = await runProcess(
      'rg',
      ['--files', '--glob', pattern, baseAbs],
      ctx.cwd,
      { timeoutMs: 15_000, maxOutputChars: 300_000 }
    )

    if (rg.exitCode === 0 || rg.exitCode === 1) {
      const files = rg.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => relative(resolve(ctx.cwd), resolve(line)))
        .slice(0, maxResults)
      if (files.length === 0) return { content: '(no files matched)', isError: false }
      return { content: files.join('\n'), isError: false }
    }

    const files = await fallbackGlob(baseAbs, baseRel, pattern, maxResults)
    if (files.length === 0) return { content: '(no files matched)', isError: false }
    return { content: `${files.join('\n')}\n[fallback: rg unavailable]`, isError: false }
  }
}
