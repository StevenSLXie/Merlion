export type TuiKeyAction = 'set_full' | 'set_compact' | 'help' | 'interrupt' | null

export function parseTuiKeyAction(input: Buffer | string): TuiKeyAction {
  const text = typeof input === 'string' ? input : input.toString('utf8')
  if (text === '\u0003') return 'interrupt' // Ctrl+C
  const trimmed = text.trim().toLowerCase()
  if (trimmed === 'f') return 'set_full'
  if (trimmed === 'c') return 'set_compact'
  if (trimmed === '?') return 'help'
  return null
}
