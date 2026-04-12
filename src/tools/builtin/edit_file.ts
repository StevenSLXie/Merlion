import { readFile, writeFile } from 'node:fs/promises'

import type { EditDiffHunk, ToolDefinition } from '../types.js'
import { validateAndResolveWorkspacePath } from './fs_common.ts'

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
  description: 'Edit file by replacing exact text. Default mode requires unique match; set replace_all=true to replace every match.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' }
    },
    required: ['old_string', 'new_string']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const pathInput = typeof input.path === 'string' ? input.path : input.file_path
    const oldString = input.old_string
    const newString = input.new_string
    const replaceAll = input.replace_all === true

    const validated = validateAndResolveWorkspacePath(ctx.cwd, pathInput)
    if (!validated.ok) return { content: validated.error, isError: true }
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return { content: 'Invalid edit payload: old_string/new_string must be strings.', isError: true }
    }

    const decision = await ctx.permissions?.ask('edit_file', `Edit: ${pathInput}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    let content: string
    try {
      content = await readFile(validated.path, 'utf8')
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
    if (!replaceAll && occurrences > 1) {
      return {
        content: `Found ${occurrences} occurrences of old_string. Provide a more specific string that uniquely identifies the target section.`,
        isError: true
      }
    }

    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    const hunk = buildEditDiffHunk(content, oldString, newString)
    const removedLines = splitForDiff(oldString).length * (replaceAll ? occurrences : 1)
    const addedLines = splitForDiff(newString).length * (replaceAll ? occurrences : 1)
    await writeFile(validated.path, updated, 'utf8')
    return {
      content: `Edited ${validated.path} (+${addedLines} -${removedLines})${replaceAll ? ` [replace_all=${occurrences}]` : ''}`,
      isError: false,
      uiPayload: hunk && occurrences === 1
        ? {
            kind: 'edit_diff',
            path: validated.path,
            addedLines,
            removedLines,
            hunks: [hunk]
          }
        : undefined
    }
  }
}
