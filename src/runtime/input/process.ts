import type { UserInputEnvelope } from './types.ts'

export function processUserInput(input: string): UserInputEnvelope {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed === ':q' || trimmed === ':quit' || trimmed === ':exit') return { kind: 'local_action', action: 'exit' }
  if (trimmed === ':help') return { kind: 'local_action', action: 'help' }

  const detailMatch = trimmed.match(/^:detail\s+(full|compact)$/i)
  if (detailMatch) {
    return {
      kind: 'local_action',
      action: 'set_detail',
      payload: detailMatch[1]!.toLowerCase() as 'full' | 'compact',
    }
  }

  const shellMatch = input.match(/^!\s+(.+)$/)
  if (shellMatch) {
    const command = shellMatch[1]!.trim()
    if (command !== '') return { kind: 'shell_shortcut', command }
  }

  const slashMatch = trimmed.match(/^\/([a-z0-9_-]+)(?:\s+.*)?$/i)
  if (slashMatch) {
    return {
      kind: 'slash_command',
      name: slashMatch[1]!.toLowerCase(),
      raw: trimmed,
    }
  }

  if (trimmed === ':wechat' || /^:wechat\s+login$/i.test(trimmed)) {
    return { kind: 'slash_command', name: 'wechat', raw: trimmed }
  }
  if (trimmed === ':undo') {
    return { kind: 'slash_command', name: 'undo', raw: trimmed }
  }

  return { kind: 'prompt', text: trimmed }
}
