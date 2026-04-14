/** Maximum WeChat message length before splitting. */
export const WEIXIN_MAX_LEN = 4000

/**
 * Strip common markdown formatting so AI responses read naturally
 * in WeChat's plain-text chat bubbles.
 */
export function toPlainText(markdown: string): string {
  let text = markdown

  // Fenced code blocks — keep the code, drop the fences
  text = text.replace(/```[\w]*\n([\s\S]*?)```/g, (_m, code: string) => code.trimEnd())
  text = text.replace(/```[\w]*([\s\S]*?)```/g, (_m, code: string) => code.trim())

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '$1')

  // Setext-style headers (underline with === or ---)
  text = text.replace(/^(.+)\n={3,}$/gm, '$1')
  text = text.replace(/^(.+)\n-{3,}$/gm, '$1')

  // ATX headers (#, ##, …)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1')

  // Bold-italic ***text***
  text = text.replace(/\*{3}([^*\n]+)\*{3}/g, '$1')
  // Bold **text** or __text__
  text = text.replace(/\*{2}([^*\n]+)\*{2}/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  // Italic *text* or _text_
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/_([^_\n]+)_/g, '$1')

  // Strikethrough
  text = text.replace(/~~([^~\n]+)~~/g, '$1')

  // Images — keep alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links — keep display text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Blockquotes
  text = text.replace(/^>\s*/gm, '')

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, '──────────────')

  // Trailing whitespace per line
  text = text.replace(/[ \t]+$/gm, '')

  return text.trim()
}

/**
 * Split text into chunks of at most `maxLen` characters,
 * preferring to split on newlines to preserve readability.
 */
export function splitForWeixin(text: string, maxLen: number = WEIXIN_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Prefer splitting at the last newline within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, '')
  }
  return chunks
}
