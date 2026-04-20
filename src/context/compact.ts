import type { ChatMessage } from '../types.js'
import type { ConversationItem } from '../runtime/items.ts'
import { createSystemItem, itemsToMessages } from '../runtime/items.ts'

export interface CompactOptions {
  keepRecent?: number
}

export interface CompactResult {
  messages: ChatMessage[]
  compacted: boolean
}

export interface CompactItemsResult {
  items: ConversationItem[]
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

function summarizeItem(item: ConversationItem, maxChars = 120): string {
  if (item.kind === 'message') {
    const clipped = item.content.length > maxChars ? `${item.content.slice(0, maxChars)}...` : item.content
    return `- ${item.role}/${item.source}: ${clipped || '(no text)'}`
  }
  if (item.kind === 'function_call') {
    const clipped = item.argumentsText.length > maxChars ? `${item.argumentsText.slice(0, maxChars)}...` : item.argumentsText
    return `- function_call ${item.name}(${clipped || '{}'})`
  }
  if (item.kind === 'function_call_output') {
    const clipped = item.outputText.length > maxChars ? `${item.outputText.slice(0, maxChars)}...` : item.outputText
    return `- function_call_output ${item.callId}: ${clipped || '(no output)'}`
  }
  const clipped = (item.summaryText ?? item.encryptedContent ?? '').slice(0, maxChars)
  return `- reasoning: ${clipped || '(no summary)'}`
}

export function estimateItemsChars(items: ConversationItem[]): number {
  return items.reduce((sum, item) => {
    if (item.kind === 'message') return sum + item.content.length + item.role.length + item.source.length + 24
    if (item.kind === 'function_call') return sum + item.name.length + item.argumentsText.length + item.callId.length + 24
    if (item.kind === 'function_call_output') return sum + item.callId.length + item.outputText.length + 24
    return sum + (item.summaryText?.length ?? 0) + (item.encryptedContent?.length ?? 0) + 24
  }, 0)
}

export function compactItems(items: ConversationItem[], options?: CompactOptions): CompactItemsResult {
  if (items.length === 0) return { items, compacted: false }
  const keepRecent = Math.max(2, Math.floor(options?.keepRecent ?? 10))
  let anchorIndex = -1

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'message' && item.role === 'user' && item.source === 'external') {
      anchorIndex = index
      break
    }
  }

  const staticPrefix: ConversationItem[] = []
  let prefixEnd = 0
  while (prefixEnd < items.length) {
    const item = items[prefixEnd]!
    if (item.kind === 'message' && item.role === 'system' && item.source === 'static') {
      staticPrefix.push(item)
      prefixEnd += 1
      continue
    }
    break
  }

  const tailStart = anchorIndex >= 0 ? anchorIndex : Math.max(prefixEnd, items.length - keepRecent)
  if (tailStart <= prefixEnd) {
    return { items, compacted: false }
  }

  const middle = items.slice(prefixEnd, tailStart)
  if (middle.length === 0) {
    return { items, compacted: false }
  }

  const summaryItem = createSystemItem(
    'Conversation compact summary (older context compressed; verify with tools before editing):\n' +
      middle.slice(-60).map((item) => summarizeItem(item)).join('\n'),
    'runtime'
  )

  return {
    items: [...staticPrefix, summaryItem, ...items.slice(tailStart)],
    compacted: true,
  }
}
