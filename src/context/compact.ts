import type { ChatMessage } from '../types.js'

export interface CompactOptions {
  keepRecent?: number
}

export interface CompactResult {
  messages: ChatMessage[]
  compacted: boolean
}

function summarizeMessage(message: ChatMessage, maxChars = 120): string {
  const content = typeof message.content === 'string' ? message.content.replace(/\s+/g, ' ').trim() : ''
  const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}...` : content
  return `- ${message.role}: ${clipped || '(no text)'}`
}

export function estimateMessagesChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => {
    const contentLen = typeof msg.content === 'string' ? msg.content.length : 0
    const toolCallLen = msg.tool_calls ? JSON.stringify(msg.tool_calls).length : 0
    return sum + contentLen + toolCallLen + 24
  }, 0)
}

export function compactMessages(messages: ChatMessage[], options?: CompactOptions): CompactResult {
  const keepRecent = Math.max(2, Math.floor(options?.keepRecent ?? 10))
  if (messages.length <= keepRecent + 2) {
    return { messages, compacted: false }
  }

  const systemMessages = messages.filter((m) => m.role === 'system')
  const primarySystem = systemMessages[0]
  const recent = messages.slice(-keepRecent)
  const recentSet = new Set(recent)
  const middle = messages.filter((m) => !recentSet.has(m) && m.role !== 'system')
  if (middle.length === 0) {
    return { messages, compacted: false }
  }

  const summaryLines = middle.slice(-60).map((m) => summarizeMessage(m))
  const summaryMessage: ChatMessage = {
    role: 'system',
    content:
      'Conversation compact summary (older context compressed; verify with tools before editing):\n' +
      summaryLines.join('\n'),
  }

  const rebuilt: ChatMessage[] = []
  if (primarySystem) rebuilt.push(primarySystem)
  rebuilt.push(summaryMessage, ...recent.filter((m) => m !== primarySystem))
  return { messages: rebuilt, compacted: true }
}
