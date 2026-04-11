import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { EditDiffHunk, ToolDefinition } from '../types.js'

function isWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = resolve(workspaceRoot)
  const target = resolve(candidatePath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  let index = 0
  let count = 0
  while (true) {
    const found = text.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function splitForDiff(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function buildEditDiffHunk(original: string, oldString: string, newString: string): EditDiffHunk | null {
  const startOffset = original.indexOf(oldString)
  if (startOffset === -1) return null
  const oldLines = splitForDiff(oldString)
  const newLines = splitForDiff(newString)
  const startLine = lineNumberAtOffset(original, startOffset)
  return {
    oldStart: startLine,
    oldLines: oldLines.length,
    newStart: startLine,
    newLines: newLines.length,
    lines: [
      ...oldLines.map((line) => ({ type: 'remove' as const, text: line })),
      ...newLines.map((line) => ({ type: 'add' as const, text: line })),
    ]
  }
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit file by replacing exact text. old_string must match exactly once in the file. new_string is the literal replacement text (plain string, not an object or dict).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const pathInput = input.path
    const oldString = input.old_string
    const newString = input.new_string

    if (typeof pathInput !== 'string' || pathInput.trim() === '') {
      return { content: 'Invalid path: expected non-empty string.', isError: true }
    }
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return { content: 'Invalid edit payload: old_string/new_string must be strings.', isError: true }
    }

    const decision = await ctx.permissions?.ask('edit_file', `Edit: ${pathInput}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    const resolvedPath = isAbsolute(pathInput) ? resolve(pathInput) : resolve(ctx.cwd, pathInput)
    if (!isWithinWorkspace(ctx.cwd, resolvedPath)) {
      return { content: 'Path is outside the workspace root and cannot be modified.', isError: true }
    }

    let content: string
    try {
      content = await readFile(resolvedPath, 'utf8')
    } catch {
      return { content: `File not found: ${pathInput}`, isError: true }
    }

    const occurrences = countOccurrences(content, oldString)
    if (occurrences === 0) {
      return {
        content: 'old_string not found in file. Check exact content including whitespace and indentation.',
        isError: true
      }
    }
    if (occurrences > 1) {
      return {
        content: `Found ${occurrences} occurrences of old_string. Provide a more specific string that uniquely identifies the target section.`,
        isError: true
      }
    }

    const updated = content.replace(oldString, newString)
    const hunk = buildEditDiffHunk(content, oldString, newString)
    const removedLines = splitForDiff(oldString).length
    const addedLines = splitForDiff(newString).length
    await writeFile(resolvedPath, updated, 'utf8')
    return {
      content: `Edited ${resolvedPath} (+${addedLines} -${removedLines})`,
      isError: false,
      uiPayload: hunk
        ? {
            kind: 'edit_diff',
            path: resolvedPath,
            addedLines,
            removedLines,
            hunks: [hunk]
          }
        : undefined
    }
  }
}
