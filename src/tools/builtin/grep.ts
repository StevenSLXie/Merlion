import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'
import { runProcess } from './process_common.ts'
import { runRipgrep } from './rg_runner.ts'

type OutputMode = 'content' | 'files_with_matches' | 'count'

const DEFAULT_HEAD_LIMIT = 250

function parseInteger(
  value: unknown,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  let parsed = Math.floor(value)
  if (options?.min !== undefined && parsed < options.min) parsed = options.min
  if (options?.max !== undefined && parsed > options.max) parsed = options.max
  return parsed
}

function parseOptionalInteger(
  value: unknown,
  options?: { min?: number; max?: number }
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  let parsed = Math.floor(value)
  if (options?.min !== undefined && parsed < options.min) parsed = options.min
  if (options?.max !== undefined && parsed > options.max) parsed = options.max
  return parsed
}

function parseOutputMode(value: unknown): OutputMode {
  if (value === 'content' || value === 'files_with_matches' || value === 'count') return value
  return 'files_with_matches'
}

function applyHeadLimit(lines: string[], headLimit: number, offset: number): { lines: string[]; truncated: boolean } {
  if (headLimit === 0) {
    return { lines: lines.slice(offset), truncated: false }
  }
  const effectiveLimit = headLimit > 0 ? headLimit : DEFAULT_HEAD_LIMIT
  const available = Math.max(0, lines.length - offset)
  const truncated = available > effectiveLimit
  return {
    lines: lines.slice(offset, offset + effectiveLimit),
    truncated
  }
}

function toLineArray(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents with ripgrep (regex).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      output_mode: { type: 'string' },
      head_limit: { type: 'integer' },
      offset: { type: 'integer' },
      type: { type: 'string' },
      multiline: { type: 'boolean' },
      '-A': { type: 'integer' },
      '-B': { type: 'integer' },
      '-C': { type: 'integer' },
      context: { type: 'integer' },
      '-n': { type: 'boolean' },
      '-i': { type: 'boolean' },
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
    const pathInput = input.path ?? '.'
    const pathStat = await stat(validated.path).catch(() => null)
    if (!pathStat) return { content: `Path does not exist: ${String(pathInput)}`, isError: true }

    const outputMode = parseOutputMode(input.output_mode)
    const glob = typeof input.glob === 'string' && input.glob.trim() !== '' ? input.glob.trim() : undefined
    const type = typeof input.type === 'string' && input.type.trim() !== '' ? input.type.trim() : undefined
    const multiline = input.multiline === true
    const headLimit = parseInteger(
      input.head_limit ?? input.max_results,
      DEFAULT_HEAD_LIMIT,
      { min: 0, max: 5_000 }
    )
    const offset = parseInteger(input.offset, 0, { min: 0, max: 50_000 })
    const context = parseOptionalInteger(
      input['-C'] ?? input.context ?? input.context_lines,
      { min: 0, max: 100 }
    )
    const before = parseOptionalInteger(input['-B'], { min: 0, max: 100 })
    const after = parseOptionalInteger(input['-A'], { min: 0, max: 100 })
    const showLineNumbers = typeof input['-n'] === 'boolean' ? input['-n'] : true
    const caseInsensitive = typeof input['-i'] === 'boolean'
      ? input['-i']
      : input.case_sensitive !== true

    const rgArgs = ['--no-heading']
    if (caseInsensitive) rgArgs.push('-i')
    if (glob) rgArgs.push('--glob', glob)
    if (type) rgArgs.push('--type', type)
    if (multiline) rgArgs.push('-U', '--multiline-dotall')
    if (outputMode === 'content') {
      if (showLineNumbers) rgArgs.push('-n')
      if (context !== undefined) {
        rgArgs.push('-C', String(context))
      } else {
        if (before !== undefined) rgArgs.push('-B', String(before))
        if (after !== undefined) rgArgs.push('-A', String(after))
      }
    } else if (outputMode === 'files_with_matches') {
      rgArgs.push('-l')
    } else {
      rgArgs.push('--count-matches')
    }
    rgArgs.push(pattern, targetPath)
    const rg = await runRipgrep(rgArgs, ctx.cwd, { timeoutMs: 20_000, maxOutputChars: 300_000 })

    if (rg.exitCode === 0) {
      const allLines = toLineArray(rg.stdout)
      if (allLines.length === 0) return { content: '(no matches found)', isError: false }
      const limited = applyHeadLimit(allLines, headLimit, offset)
      if (limited.lines.length === 0) return { content: '(no matches found)', isError: false }
      return {
        content: `${limited.lines.join('\n')}${
          limited.truncated ? '\n(Results are truncated. Use offset to paginate.)' : ''
        }`,
        isError: false
      }
    }
    if (rg.exitCode === 1) {
      return { content: '(no matches found)', isError: false }
    }
    if (rg.exitCode !== -1) {
      return { content: `grep failed with rg: ${rg.stderr || '(no stderr)'}`, isError: true }
    }

    const grepArgs = outputMode === 'files_with_matches'
      ? ['-rl']
      : outputMode === 'count'
        ? ['-r', '-c']
        : ['-rn']
    if (outputMode === 'content' && showLineNumbers) grepArgs.push('--line-number')
    if (caseInsensitive) grepArgs.push('-i')
    if (context !== undefined && outputMode === 'content') {
      grepArgs.push('-C', String(context))
    } else if (outputMode === 'content') {
      if (before !== undefined) grepArgs.push('-B', String(before))
      if (after !== undefined) grepArgs.push('-A', String(after))
    }
    if (glob) grepArgs.push('--include', glob)
    grepArgs.push(pattern, resolve(targetPath))
    const grep = await runProcess('grep', grepArgs, ctx.cwd, { timeoutMs: 20_000 })
    if (grep.exitCode === 0) {
      const allLines = toLineArray(grep.stdout)
      if (allLines.length === 0) return { content: '(no matches found)', isError: false }
      const limited = applyHeadLimit(allLines, headLimit, offset)
      if (limited.lines.length === 0) return { content: '(no matches found)', isError: false }
      return {
        content: `${limited.lines.join('\n')}${
          limited.truncated ? '\n(Results are truncated. Use offset to paginate.)' : ''
        }\n[fallback: grep used because rg is unavailable]`,
        isError: false
      }
    }
    if (grep.exitCode === 1) {
      return { content: '(no matches found)', isError: false }
    }
    return { content: `grep failed: ${grep.stderr || '(no stderr)'}`, isError: true }
  }
}
