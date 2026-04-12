import { marked, type Token, type Tokens } from 'marked'
import { sanitizeRenderableText } from './sanitize.ts'

export interface MarkdownRenderLine {
  kind: 'plain' | 'heading' | 'list' | 'quote' | 'code' | 'code_meta' | 'rule' | 'table'
  text: string
}

function pushRenderedLines(
  rendered: MarkdownRenderLine[],
  kind: MarkdownRenderLine['kind'],
  text: string
): void {
  const lines = sanitizeRenderableText(text).split('\n')
  for (const line of lines) {
    rendered.push({ kind, text: line })
  }
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens.map((token) => renderInlineToken(token)).join('')
}

function renderInlineToken(token: Token): string {
  if (token.type === 'text') {
    const textToken = token as Tokens.Text
    if (textToken.tokens && textToken.tokens.length > 0) {
      return renderInlineTokens(textToken.tokens)
    }
    return sanitizeRenderableText(textToken.text ?? textToken.raw ?? '')
  }
  if (token.type === 'codespan') {
    return sanitizeRenderableText((token as Tokens.Codespan).text)
  }
  if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
    return renderInlineTokens((token as Tokens.Del | Tokens.Em | Tokens.Strong).tokens)
  }
  if (token.type === 'link') {
    const link = token as Tokens.Link
    const content = renderInlineTokens(link.tokens).trim()
    if (content === '' || content === link.href) return sanitizeRenderableText(link.href)
    return `${content} <${sanitizeRenderableText(link.href)}>`
  }
  if (token.type === 'image') {
    const image = token as Tokens.Image
    const label = sanitizeRenderableText((image.text ?? '').trim())
    if (label === '') return `<${sanitizeRenderableText(image.href)}>`
    return `${label} <${sanitizeRenderableText(image.href)}>`
  }
  if (token.type === 'escape') {
    return sanitizeRenderableText((token as Tokens.Escape).text)
  }
  if (token.type === 'html') {
    return sanitizeRenderableText(stripHtmlTags((token as Tokens.HTML).raw ?? ''))
  }
  if (token.type === 'br') {
    return '\n'
  }
  return sanitizeRenderableText((token as { raw?: string }).raw ?? '')
}

function renderTableRows(headers: string[], rows: string[][]): MarkdownRenderLine[] {
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length))
  const widths = new Array<number>(columnCount).fill(3)
  for (let i = 0; i < columnCount; i++) {
    widths[i] = Math.max(
      widths[i] ?? 3,
      headers[i]?.length ?? 0,
      ...rows.map((row) => row[i]?.length ?? 0)
    )
  }

  const pad = (value: string, width: number): string => {
    if (value.length >= width) return value
    return `${value}${' '.repeat(width - value.length)}`
  }

  const formatRow = (cells: string[]): string => {
    const values: string[] = []
    for (let i = 0; i < columnCount; i++) {
      values.push(pad(cells[i] ?? '', widths[i] ?? 3))
    }
    return `│ ${values.join(' │ ')} │`
  }

  const top = `┌${widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`
  const middle = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`
  const bottom = `└${widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`
  const lines: MarkdownRenderLine[] = [
    { kind: 'table', text: top },
    { kind: 'table', text: formatRow(headers) },
    { kind: 'table', text: middle }
  ]
  for (const row of rows) {
    lines.push({ kind: 'table', text: formatRow(row) })
  }
  lines.push({ kind: 'table', text: bottom })
  return lines
}

function renderTable(token: Tokens.Table): MarkdownRenderLine[] {
  const headers = token.header.map((cell) => renderInlineTokens(cell.tokens).replace(/\s+/g, ' ').trim())
  const rows = token.rows.map((row) =>
    row.map((cell) => renderInlineTokens(cell.tokens).replace(/\s+/g, ' ').trim())
  )
  return renderTableRows(headers, rows)
}

function parsePipeTableBlock(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length < 2) return null
  if (!lines[0]!.includes('|') || !lines[1]!.includes('|')) return null
  if (!/^[:\-\|\s]+$/.test(lines[1]!)) return null

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const headers = parseRow(lines[0]!)
  if (headers.length === 0) return null
  const rows = lines.slice(2).map(parseRow)
  return { headers, rows }
}

function renderListItem(
  item: Tokens.ListItem,
  rendered: MarkdownRenderLine[],
  depth: number,
  orderedNumber?: number
): void {
  const nested: MarkdownRenderLine[] = []
  renderBlockTokens(item.tokens ?? [], nested, depth + 1)

  const indent = '  '.repeat(depth)
  const bullet = orderedNumber === undefined ? '•' : `${orderedNumber}.`
  if (nested.length === 0) {
    rendered.push({ kind: 'list', text: `${indent}${bullet}` })
    return
  }

  const [first, ...rest] = nested
  const firstText = first && first.text.trim() !== ''
    ? `${indent}${bullet} ${first.text}`
    : `${indent}${bullet}`
  rendered.push({ kind: 'list', text: firstText })

  for (const line of rest) {
    const continuation = `${indent}  `
    if (line.text.trim() === '') {
      rendered.push({ kind: 'list', text: continuation.trimEnd() })
      continue
    }
    const kind = line.kind === 'plain' || line.kind === 'list'
      ? 'list'
      : line.kind
    rendered.push({ kind, text: `${continuation}${line.text}` })
  }
}

export function looksLikeMarkdown(text: string): boolean {
  if (text.trim() === '') return false
  return /(^|\n)(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|[-*_]{3,}\s*$|\|.+\|)/m.test(text)
}

function renderBlockTokens(tokens: Token[], rendered: MarkdownRenderLine[], listDepth: number): void {
  for (const token of tokens) {
    if (token.type === 'space') {
      rendered.push({ kind: 'plain', text: '' })
      continue
    }
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      const text = renderInlineTokens(heading.tokens).trim()
      rendered.push({ kind: 'heading', text })
      continue
    }
    if (token.type === 'paragraph') {
      const paragraph = token as Tokens.Paragraph
      const paragraphText = renderInlineTokens(paragraph.tokens)
      const tableBlock = parsePipeTableBlock(paragraphText)
      if (tableBlock) {
        rendered.push(...renderTableRows(tableBlock.headers, tableBlock.rows))
      } else {
        pushRenderedLines(rendered, 'plain', paragraphText)
      }
      continue
    }
    if (token.type === 'text') {
      const textToken = token as Tokens.Text
      if (textToken.tokens && textToken.tokens.length > 0) {
        pushRenderedLines(rendered, 'plain', renderInlineTokens(textToken.tokens))
      } else {
        pushRenderedLines(rendered, 'plain', textToken.text)
      }
      continue
    }
    if (token.type === 'blockquote') {
      const blockquote = token as Tokens.Blockquote
      const quoted: MarkdownRenderLine[] = []
      renderBlockTokens(blockquote.tokens ?? [], quoted, listDepth)
      if (quoted.length === 0) {
        rendered.push({ kind: 'quote', text: '│' })
      } else {
        for (const line of quoted) {
          rendered.push({
            kind: 'quote',
            text: line.text.trim() === '' ? '│' : `│ ${line.text}`
          })
        }
      }
      continue
    }
    if (token.type === 'list') {
      const list = token as Tokens.List
      const start = typeof list.start === 'number'
        ? list.start
        : Number.parseInt(String(list.start ?? '1'), 10) || 1
      list.items.forEach((item, index) => {
        const orderedNumber = list.ordered ? start + index : undefined
        renderListItem(item, rendered, listDepth, orderedNumber)
      })
      continue
    }
    if (token.type === 'list_item') {
      renderListItem(token as Tokens.ListItem, rendered, listDepth)
      continue
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code
      const language = sanitizeRenderableText((code.lang ?? '').trim()) || 'text'
      rendered.push({ kind: 'code_meta', text: `code:${language}` })
      const body = sanitizeRenderableText(code.text ?? '')
      const lines = body.split('\n')
      if (lines.length === 0) {
        rendered.push({ kind: 'code', text: '' })
      } else {
        for (const line of lines) rendered.push({ kind: 'code', text: line })
      }
      continue
    }
    if (token.type === 'hr') {
      rendered.push({ kind: 'rule', text: '────────────────────────' })
      continue
    }
    if (token.type === 'table') {
      rendered.push(...renderTable(token as Tokens.Table))
      continue
    }
    if (token.type === 'html') {
      const text = sanitizeRenderableText(stripHtmlTags((token as Tokens.HTML).raw ?? '')).trim()
      if (text !== '') rendered.push({ kind: 'plain', text })
      continue
    }
    const fallback = sanitizeRenderableText((token as { raw?: string }).raw ?? '').trim()
    if (fallback !== '') rendered.push({ kind: 'plain', text: fallback })
  }
}

export function renderMarkdownLines(markdown: string): MarkdownRenderLine[] {
  const input = sanitizeRenderableText(markdown.replace(/\r\n/g, '\n'))
  const rendered: MarkdownRenderLine[] = []
  try {
    const tokens = marked.lexer(input)
    renderBlockTokens(tokens, rendered, 0)
  } catch {
    pushRenderedLines(rendered, 'plain', input)
  }

  while (rendered.length > 0) {
    const last = rendered[rendered.length - 1]
    if (!last || last.text !== '' || (last.kind !== 'plain' && last.kind !== 'list' && last.kind !== 'quote')) break
    rendered.pop()
  }
  return rendered
}
