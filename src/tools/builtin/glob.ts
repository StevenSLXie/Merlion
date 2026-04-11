import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { parsePositiveInt, validateAndResolveWorkspacePath } from './fs_common.ts'
import { runRipgrep } from './rg_runner.ts'

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/§§DOUBLESTAR§§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function fallbackGlob(baseAbs: string, pattern: string, limit: number): Promise<string[]> {
  const regex = globToRegExp(pattern)
  const out: string[] = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: baseAbs, rel: '' }]

  while (queue.length > 0 && out.length < limit) {
    const next = queue.shift()!
    const entries = await readdir(next.abs, { withFileTypes: true })
    for (const entry of entries) {
      if (out.length >= limit) break
      const childRel = next.rel === '' ? entry.name : `${next.rel}/${entry.name}`
      if (entry.isDirectory()) {
        queue.push({ abs: join(next.abs, entry.name), rel: childRel })
      } else if (entry.isFile() && regex.test(childRel)) {
        out.push(childRel)
      }
    }
  }
  return out
}

async function sortByMtimeDesc(cwd: string, relativePaths: string[]): Promise<string[]> {
  const withMeta = await Promise.all(relativePaths.map(async (relPath, idx) => {
    const abs = resolve(cwd, relPath)
    try {
      const st = await stat(abs)
      return { relPath, mtimeMs: st.mtimeMs, idx }
    } catch {
      return { relPath, mtimeMs: -1, idx }
    }
  }))
  withMeta.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    return a.idx - b.idx
  })
  return withMeta.map((x) => x.relPath)
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'List files matching a glob pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      max_results: { type: 'integer' },
      sort_by: { type: 'string' }
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
    const baseStat = await stat(validated.path).catch(() => null)
    if (!baseStat) return { content: `Path does not exist: ${String(input.path ?? '.')}`, isError: true }
    if (!baseStat.isDirectory()) return { content: `Path is not a directory: ${String(input.path ?? '.')}`, isError: true }

    const maxResults = parsePositiveInt(input.max_results, 100, 1, 2000)
    const baseAbs = validated.path
    const baseRel = relative(resolve(ctx.cwd), baseAbs) || '.'
    const sortBy = typeof input.sort_by === 'string' ? input.sort_by.trim().toLowerCase() : 'mtime'

    const rg = await runRipgrep(
      ['--files', '--glob', pattern, '.'],
      baseAbs,
      { timeoutMs: 15_000, maxOutputChars: 300_000 }
    )

    if (rg.exitCode === 0 || rg.exitCode === 1) {
      let files = rg.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => line.startsWith('./') ? line.slice(2) : line)
        .map((line) => baseRel === '.' ? line : `${baseRel}/${line}`)
      files = sortBy === 'none' ? files : await sortByMtimeDesc(ctx.cwd, files)
      const truncated = files.length > maxResults
      files = files.slice(0, maxResults)
      if (files.length === 0) return { content: '(no files matched)', isError: false }
      return {
        content: truncated
          ? `${files.join('\n')}\n(Results are truncated. Consider using a more specific path or pattern.)`
          : files.join('\n'),
        isError: false
      }
    }

    if (rg.exitCode !== -1) {
      return { content: `glob failed with rg: ${rg.stderr || '(no stderr)'}`, isError: true }
    }

    let files = await fallbackGlob(baseAbs, pattern, maxResults + 1)
    files = files.map((line) => baseRel === '.' ? line : `${baseRel}/${line}`)
    files = sortBy === 'none' ? files : await sortByMtimeDesc(ctx.cwd, files)
    const truncated = files.length > maxResults
    files = files.slice(0, maxResults)
    if (files.length === 0) return { content: '(no files matched)', isError: false }
    return {
      content: `${files.join('\n')}${
        truncated ? '\n(Results are truncated. Consider using a more specific path or pattern.)' : ''
      }\n[fallback: pure-js glob used because rg is unavailable]`,
      isError: false
    }
  }
}
