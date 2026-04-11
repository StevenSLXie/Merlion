import type { EditDiffUiPayload } from '../tools/types.js'
import { sanitizeRenderableText } from './sanitize.ts'

export interface RenderedDiffLine {
  tone: 'meta' | 'context' | 'add' | 'remove'
  text: string
}

function clip(text: string, maxChars: number): string {
  if (maxChars < 1) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'
  return `${text.slice(0, maxChars - 1)}…`
}

export function renderEditDiffLines(
  payload: EditDiffUiPayload,
  options?: { maxLines?: number; maxCharsPerLine?: number }
): RenderedDiffLine[] {
  const maxLines = Math.max(8, options?.maxLines ?? 120)
  const maxCharsPerLine = Math.max(20, options?.maxCharsPerLine ?? 240)
  const lines: RenderedDiffLine[] = [
    {
      tone: 'meta',
      text: `diff ${sanitizeRenderableText(payload.path)} (+${payload.addedLines} -${payload.removedLines})`
    }
  ]

  for (const hunk of payload.hunks) {
    lines.push({
      tone: 'meta',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    })
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
      lines.push({
        tone: line.type,
        text: `${prefix}${sanitizeRenderableText(line.text)}`
      })
    }
  }

  const clipped = lines.map((line) => ({
    tone: line.tone,
    text: clip(line.text, maxCharsPerLine)
  }))

  if (clipped.length <= maxLines) return clipped
  const keep = Math.max(2, maxLines - 1)
  return [
    ...clipped.slice(0, keep),
    { tone: 'meta', text: `... diff truncated (${clipped.length - keep} line(s) hidden)` }
  ]
}

export function summarizeEditDiff(payload: EditDiffUiPayload): RenderedDiffLine[] {
  const totalChanged = payload.addedLines + payload.removedLines
  return [
    {
      tone: 'meta',
      text: `diff ${sanitizeRenderableText(payload.path)} (+${payload.addedLines} -${payload.removedLines})`
    },
    {
      tone: 'meta',
      text: `${payload.hunks.length} hunk(s), ${totalChanged} changed line(s)`
    }
  ]
}
