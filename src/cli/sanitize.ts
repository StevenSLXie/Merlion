const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const LONG_TOKEN_RE = /\S{33,}/g
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d
    const isC1Control = code >= 0x7f && code <= 0x9f
    if (isAsciiControl || isC1Control) return true
  }
  return false
}

function stripControlChars(text: string): string {
  if (!hasControlChars(text)) return text
  let out = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d
    const isC1Control = code >= 0x7f && code <= 0x9f
    if (!isAsciiControl && !isC1Control) out += ch
  }
  return out
}

function isCopySensitiveToken(token: string): boolean {
  if (URL_PREFIX_RE.test(token)) return true
  if (
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token.startsWith('./') ||
    token.startsWith('../')
  ) {
    return true
  }
  if (WINDOWS_DRIVE_RE.test(token) || token.startsWith('\\\\')) return true
  if (token.includes('/') || token.includes('\\')) return true
  return token.includes('_') && FILE_LIKE_RE.test(token)
}

function chunkToken(token: string, max = 32): string {
  if (token.length <= max || isCopySensitiveToken(token)) return token
  const chunks: string[] = []
  for (let i = 0; i < token.length; i += max) {
    chunks.push(token.slice(i, i + max))
  }
  return chunks.join(' ')
}

export function sanitizeRenderableText(text: string): string {
  if (!text) return text
  let out = text
  if (out.includes('\u001b')) {
    out = out.replace(ANSI_RE, '')
  }
  out = stripControlChars(out)
  if (LONG_TOKEN_RE.test(out)) {
    out = out.replace(LONG_TOKEN_RE, (token) => chunkToken(token))
  }
  return out
}
