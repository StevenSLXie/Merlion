/** Returns the terminal display width (columns) of a single Unicode code point. */
function codePointWidth(cp: number): number {
  if (cp === 0) return 0
  // C0/C1 control characters
  if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) return 0
  // Combining / zero-width
  if (
    (cp >= 0x0300 && cp <= 0x036F) || // Combining Diacritical Marks
    (cp >= 0x200B && cp <= 0x200F) || // Zero-width spaces / joiners
    cp === 0xFEFF                      // BOM / zero-width no-break space
  ) return 0

  // Wide characters (display width = 2)
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    cp === 0x2329 || cp === 0x232A ||   // Angle brackets
    (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals, Kangxi, etc.
    (cp >= 0x3040 && cp <= 0x33FF) ||  // Hiragana, Katakana, CJK compat
    (cp >= 0x3400 && cp <= 0x4DBF) ||  // CJK Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified Ideographs
    (cp >= 0xA000 && cp <= 0xA4CF) ||  // Yi
    (cp >= 0xA960 && cp <= 0xA97F) ||  // Hangul Jamo Extended-A
    (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compatibility Ideographs
    (cp >= 0xFE10 && cp <= 0xFE19) ||  // Vertical Forms
    (cp >= 0xFE30 && cp <= 0xFE6F) ||  // CJK Compatibility Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||  // Fullwidth Signs
    (cp >= 0x1F004 && cp <= 0x1F0CF) || // Mahjong / Playing Cards
    (cp >= 0x1F300 && cp <= 0x1FAFF) || // Misc Symbols, Emoji
    (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Extension B–F
    (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Extension G+
  ) return 2

  return 1
}

/** Terminal display width of a string (no ANSI codes expected). */
export function displayWidth(str: string): number {
  let width = 0
  for (const char of str) {
    width += codePointWidth(char.codePointAt(0) ?? 0)
  }
  return width
}

/** Strip ANSI escape sequences then return terminal display width. */
export function plainDisplayWidth(str: string): number {
  return displayWidth(str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ''))
}

/**
 * Clip `text` so its display width does not exceed `maxWidth`.
 * Appends `…` if clipping was needed (the `…` counts as 1 column).
 */
export function clipToWidth(text: string, maxWidth: number): string {
  if (maxWidth < 1) return ''

  // Fast path: measure full width first
  const fullWidth = displayWidth(text)
  if (fullWidth <= maxWidth) return text

  // Leave 1 column for the ellipsis character
  const targetWidth = maxWidth - 1
  let width = 0
  let byteIdx = 0
  for (const char of text) {
    const cw = codePointWidth(char.codePointAt(0) ?? 0)
    if (width + cw > targetWidth) break
    width += cw
    byteIdx += char.length
  }
  return `${text.slice(0, byteIdx)}…`
}

/**
 * Pad `text` with trailing spaces until its display width equals `width`.
 * Returns text unchanged if it already meets or exceeds `width`.
 */
export function padToWidth(text: string, width: number): string {
  const actual = displayWidth(text)
  if (actual >= width) return text
  return `${text}${' '.repeat(width - actual)}`
}
