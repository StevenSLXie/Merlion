import type { ToolDefinition } from '../types.js'
import { readFile, stat } from 'node:fs/promises'
import { enforceReadPolicy, resolveReadTargetPath } from './fs_common.ts'

const ONE_GIB = 1024 * 1024 * 1024

function normalizeLines(content: string): string[] {
  const lines = content.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const parsed = Math.floor(value)
  return parsed > 0 ? parsed : undefined
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read file contents. Supports line ranges via offset/limit or start_line/end_line.',
  modelGuidance: [
    '- Use a raw workspace path only; do not include labels, code fences, or prose around the path.',
    '- Prefer targeted line ranges instead of rereading a whole file after every small step.',
    '- If you do not know the path yet, use list_dir, glob, grep, or search first.',
    '- Returned line numbers are display metadata; do not copy the numeric prefixes into edits.'
  ].join('\n'),
  modelExamples: [
    '{"path":"src/index.ts","start_line":1,"end_line":80}'
  ],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      file_path: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
      start_line: { type: 'integer' },
      end_line: { type: 'integer' }
    },
    required: []
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const rawPath = typeof input.path === 'string' ? input.path : input.file_path
    const resolvedTarget = await resolveReadTargetPath(ctx.cwd, rawPath)
    if (!resolvedTarget.ok) return { content: resolvedTarget.error, isError: true }
    const resolvedPath = resolvedTarget.path
    const readPolicy = enforceReadPolicy(ctx, resolvedPath)
    if (!readPolicy.ok) return { content: readPolicy.error, isError: true }

    let fileStat
    try {
      fileStat = await stat(resolvedPath)
    } catch {
      return { content: `File not found: ${rawPath}`, isError: true }
    }

    if (!fileStat.isFile()) {
      return { content: `Path is a directory, not a file: ${rawPath}`, isError: true }
    }

    if (fileStat.size > ONE_GIB) {
      return { content: `File too large (> 1 GiB): ${rawPath}`, isError: true }
    }

    const content = await readFile(resolvedPath, 'utf8')
    if (content.length === 0) {
      return { content: '(empty file)', isError: false }
    }

    const lines = normalizeLines(content)
    if (lines.length === 0) {
      return { content: '(empty file)', isError: false }
    }

    const startFromOffset = (() => {
      if (typeof input.offset !== 'number' || !Number.isFinite(input.offset)) return undefined
      const normalized = Math.floor(input.offset)
      if (normalized < 1) return 1
      return normalized
    })()
    const limit = toPositiveInt(input.limit)
    const startLine = toPositiveInt(input.start_line) ?? startFromOffset ?? 1
    const endLine = toPositiveInt(input.end_line) ?? (
      limit !== undefined
        ? startLine + limit - 1
        : lines.length
    )

    if (endLine < startLine) {
      return {
        content: `Invalid line range: start_line (${startLine}) is greater than end_line (${endLine}).`,
        isError: true
      }
    }

    const startIdx = Math.max(0, startLine - 1)
    const endIdx = Math.min(lines.length, endLine)
    const selected = lines.slice(startIdx, endIdx)

    if (selected.length === 0) {
      return { content: '(no lines in requested range)', isError: false }
    }

    const numbered = selected
      .map((line, idx) => `${startIdx + idx + 1}\t${line}`)
      .join('\n')

    return { content: numbered, isError: false }
  }
}
