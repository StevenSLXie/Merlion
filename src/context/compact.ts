import type { ConversationItem } from '../runtime/items.ts'
import { createSystemItem } from '../runtime/items.ts'

export interface CompactOptions {
  keepRecent?: number
}

export interface CompactItemsResult {
  items: ConversationItem[]
  compacted: boolean
}

interface PreservedInterval {
  start: number
  end: number
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

function findLastExternalUserAnchorIndex(items: ConversationItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'message' && item.role === 'user' && item.source === 'external') {
      return index
    }
  }
  return -1
}

function findLatestActionObservationTrace(items: ConversationItem[]): PreservedInterval | null {
  for (let outputIndex = items.length - 1; outputIndex >= 0; outputIndex -= 1) {
    const outputItem = items[outputIndex]
    if (!outputItem || outputItem.kind !== 'function_call_output') continue
    for (let callIndex = outputIndex - 1; callIndex >= 0; callIndex -= 1) {
      const callItem = items[callIndex]
      if (!callItem || callItem.kind !== 'function_call') continue
      if (callItem.callId !== outputItem.callId) continue
      return { start: callIndex, end: outputIndex + 1 }
    }
  }
  return null
}

function mergeIntervals(intervals: PreservedInterval[]): PreservedInterval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: PreservedInterval[] = [{ ...sorted[0]! }]
  for (const interval of sorted.slice(1)) {
    const current = merged[merged.length - 1]!
    if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end)
      continue
    }
    merged.push({ ...interval })
  }
  return merged
}

function createCompactSummaryItem(items: ConversationItem[]): ConversationItem {
  return createSystemItem(
    'Conversation compact summary (older context compressed; verify with tools before editing):\n' +
      items.slice(-60).map((item) => summarizeItem(item)).join('\n'),
    'runtime'
  )
}

export function compactItems(items: ConversationItem[], options?: CompactOptions): CompactItemsResult {
  if (items.length === 0) return { items, compacted: false }
  const keepRecent = Math.max(2, Math.floor(options?.keepRecent ?? 10))

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

  const transcriptTailItems = items.slice(prefixEnd)
  if (transcriptTailItems.length === 0) {
    return { items, compacted: false }
  }

  const preservedIntervals: PreservedInterval[] = [{
    start: Math.max(0, transcriptTailItems.length - keepRecent),
    end: transcriptTailItems.length,
  }]
  const anchorIndex = findLastExternalUserAnchorIndex(transcriptTailItems)
  if (anchorIndex >= 0) {
    preservedIntervals.push({ start: anchorIndex, end: anchorIndex + 1 })
  }
  const latestTrace = findLatestActionObservationTrace(transcriptTailItems)
  if (latestTrace) preservedIntervals.push(latestTrace)

  const mergedIntervals = mergeIntervals(preservedIntervals)
  if (mergedIntervals.length === 1 && mergedIntervals[0]!.start === 0 && mergedIntervals[0]!.end === transcriptTailItems.length) {
    return { items, compacted: false }
  }

  const projectedTailItems: ConversationItem[] = []
  let previousEnd = 0
  for (const interval of mergedIntervals) {
    const droppedSegment = transcriptTailItems.slice(previousEnd, interval.start)
    if (droppedSegment.length > 0) {
      projectedTailItems.push(createCompactSummaryItem(droppedSegment))
    }
    projectedTailItems.push(...transcriptTailItems.slice(interval.start, interval.end))
    previousEnd = interval.end
  }

  const trailingDroppedSegment = transcriptTailItems.slice(previousEnd)
  if (trailingDroppedSegment.length > 0) {
    projectedTailItems.push(createCompactSummaryItem(trailingDroppedSegment))
  }

  return {
    items: [...staticPrefix, ...projectedTailItems],
    compacted: true,
  }
}
