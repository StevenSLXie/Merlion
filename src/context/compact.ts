import type { ConversationItem } from '../runtime/items.ts'
import { createSystemItem } from '../runtime/items.ts'

export interface CompactOptions {
  keepRecent?: number
}

export interface CompactItemsResult {
  items: ConversationItem[]
  compacted: boolean
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
