import { sanitizeRenderableText } from './sanitize.ts'

export interface MarkdownRenderLine {
  kind: 'plain' | 'heading' | 'list' | 'quote' | 'code' | 'rule' | 'table'
  text: string
}

function normalizeInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
}

export function looksLikeMarkdown(text: string): boolean {
  if (text.trim() === '') return false
  return /(^|\n)(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|[-*_]{3,}\s*$|\|.+\|)/m.test(text)
}

export function renderMarkdownLines(markdown: string): MarkdownRenderLine[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const rendered: MarkdownRenderLine[] = []
  let inCode = false

  for (const line of lines) {
    const raw = sanitizeRenderableText(line)
    if (/^```/.test(raw.trim())) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      rendered.push({ kind: 'code', text: raw })
      continue
    }
    if (/^\s*$/.test(raw)) {
      rendered.push({ kind: 'plain', text: '' })
      continue
    }
    const heading = raw.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const prefix = '#'.repeat(level)
      rendered.push({ kind: 'heading', text: `${prefix} ${normalizeInline(heading[2])}` })
      continue
    }
    const quote = raw.match(/^\s*>\s?(.*)$/)
    if (quote) {
      rendered.push({ kind: 'quote', text: `> ${normalizeInline(quote[1])}` })
      continue
    }
    const list = raw.match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
    if (list) {
      rendered.push({ kind: 'list', text: `${list[1]} ${normalizeInline(list[2])}` })
      continue
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(raw)) {
      rendered.push({ kind: 'rule', text: '────────────────────────' })
      continue
    }
    if (raw.includes('|') && /\|/.test(raw.trim())) {
      rendered.push({ kind: 'table', text: normalizeInline(raw) })
      continue
    }
    rendered.push({ kind: 'plain', text: normalizeInline(raw) })
  }

  while (rendered.length > 0) {
    const last = rendered[rendered.length - 1]
    if (!last || last.kind !== 'plain' || last.text !== '') break
    rendered.pop()
  }
  return rendered
}
