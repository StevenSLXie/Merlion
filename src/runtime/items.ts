import type { AssistantResponse, ChatMessage, ToolCall } from '../types.js'

export interface UserMessageItem {
  kind: 'message'
  role: 'user'
  content: string
  source: 'external' | 'runtime'
  itemId?: string
}

export interface AssistantMessageItem {
  kind: 'message'
  role: 'assistant'
  content: string
  source: 'provider'
  itemId?: string
}

export interface SystemMessageItem {
  kind: 'message'
  role: 'system'
  content: string
  source: 'static' | 'runtime'
  itemId?: string
}

export interface ReasoningItem {
  kind: 'reasoning'
  itemId?: string
  summaryText?: string
  encryptedContent?: string
}

export interface FunctionCallItem {
  kind: 'function_call'
  itemId?: string
  callId: string
  name: string
  argumentsText: string
}

export interface FunctionCallOutputItem {
  kind: 'function_call_output'
  itemId?: string
  callId: string
  outputText: string
  isError?: boolean
}

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | SystemMessageItem
  | ReasoningItem
  | FunctionCallItem
  | FunctionCallOutputItem

export interface ProviderCapabilities {
  transcriptMode: 'items' | 'messages'
  supportsReasoningItems: boolean
  supportsPreviousResponseId: boolean
}

export interface ProviderResponseBoundary {
  runtimeResponseId: string
  providerResponseId?: string
  provider: string
  model?: string
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  outputItemCount: number
  createdAt: string
}

export interface ProviderResult {
  outputItems: ConversationItem[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
    provider?: string
  }
  providerResponseId?: string
  responseBoundary?: ProviderResponseBoundary
}

export interface TranscriptResponseEntry {
  type: 'response'
  response: ProviderResponseBoundary
}

export interface TranscriptItemEntry {
  type: 'item'
  item: ConversationItem
  origin: 'provider_output' | 'local_tool_output' | 'local_runtime'
  runtimeResponseId?: string
}

const LEGACY_RUNTIME_USER_PATTERNS: RegExp[] = [
  /^Output was cut off\. Continue directly from where you stopped\./i,
  /^You just finished tool execution\. Please provide a natural-language final summary/i,
  /^You have not made any successful file changes yet\. Do not finish now\./i,
  /^Continue with the task\. Use your tools to make progress\./i,
  /^You appear to be looping on tool errors\./i,
  /^Tool argument validation failed/i,
  /^Exploration budget exceeded:/i,
  /^No concrete progress has been made/i,
  /^You only changed tests so far\./i,
  /^Please verify the change before finishing\./i,
  /^You are drifting in todo-only updates\./i,
  /^A large edit was just made\./i,
  /^You rewrote a file immediately after an edit/i,
  /^Write a natural-language summary of what you completed in this run\./i,
]

const NON_PERSISTENT_RUNTIME_SYSTEM_PATTERNS: RegExp[] = [
  /^User-specified target paths detected\./i,
  /^Prompt-derived path guidance\./i,
  /^Path guidance update\./i,
  /^Execution charter for this turn:/i,
  /^Execution contract for the current request\./i,
]

function normalizeContent(content: string | null | undefined): string {
  return typeof content === 'string' ? content : ''
}

function isBlank(value: string | null | undefined): boolean {
  return normalizeContent(value).trim() === ''
}

function classifyLegacyUserMessage(content: string): 'external' | 'runtime' {
  for (const pattern of LEGACY_RUNTIME_USER_PATTERNS) {
    if (pattern.test(content.trim())) return 'runtime'
  }
  return 'external'
}

function isLegacyRuntimeUserMessage(content: string): boolean {
  return classifyLegacyUserMessage(content) === 'runtime'
}

function isNonPersistentRuntimeSystemMessage(content: string): boolean {
  const normalized = content.trim()
  for (const pattern of NON_PERSISTENT_RUNTIME_SYSTEM_PATTERNS) {
    if (pattern.test(normalized)) return true
  }
  return false
}

export function toolCallToFunctionCallItem(call: ToolCall): FunctionCallItem {
  return {
    kind: 'function_call',
    itemId: call.id,
    callId: call.id,
    name: call.function.name,
    argumentsText: call.function.arguments,
  }
}

export function toolResultMessageToOutputItem(message: ChatMessage): FunctionCallOutputItem | null {
  if (message.role !== 'tool' || typeof message.tool_call_id !== 'string' || message.tool_call_id.trim() === '') {
    return null
  }
  return {
    kind: 'function_call_output',
    callId: message.tool_call_id,
    outputText: normalizeContent(message.content),
    isError: undefined,
  }
}

export function legacyMessageToItems(
  message: ChatMessage,
  options?: { systemIndex?: number }
): ConversationItem[] {
  if (message.role === 'assistant') {
    const items: ConversationItem[] = []
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    if (!hasToolCalls || !isBlank(message.content)) {
      items.push({
        kind: 'message',
        role: 'assistant',
        content: normalizeContent(message.content),
        source: 'provider',
      })
    }
    if (hasToolCalls) {
      for (const call of message.tool_calls!) items.push(toolCallToFunctionCallItem(call))
    }
    return items
  }

  if (message.role === 'tool') {
    const output = toolResultMessageToOutputItem(message)
    return output ? [output] : []
  }

  if (message.role === 'system') {
    return [{
      kind: 'message',
      role: 'system',
      content: normalizeContent(message.content),
      source: (options?.systemIndex ?? 0) === 0 ? 'static' : 'runtime',
    }]
  }

  return [{
    kind: 'message',
    role: 'user',
    content: normalizeContent(message.content),
    source: classifyLegacyUserMessage(normalizeContent(message.content)),
  }]
}

export function messagesToItems(messages: ChatMessage[]): ConversationItem[] {
  const items: ConversationItem[] = []
  let systemIndex = 0
  for (const message of messages) {
    const converted = legacyMessageToItems(message, { systemIndex })
    items.push(...converted)
    if (message.role === 'system') systemIndex += 1
  }
  return items
}

export function isNonPersistentRuntimeItem(item: ConversationItem): boolean {
  if (item.kind !== 'message') return false
  if (item.role === 'user' && item.source === 'runtime') {
    return isLegacyRuntimeUserMessage(item.content)
  }
  if (item.role === 'system' && item.source === 'runtime') {
    return isNonPersistentRuntimeSystemMessage(item.content)
  }
  return false
}

export function pruneNonPersistentRuntimeItems(items: ConversationItem[]): ConversationItem[] {
  return items.filter((item) => !isNonPersistentRuntimeItem(item))
}

export function splitStablePrefixItems(items: ConversationItem[]): {
  stablePrefixItems: ConversationItem[]
  transcriptTailItems: ConversationItem[]
} {
  let splitIndex = 0
  while (splitIndex < items.length) {
    const item = items[splitIndex]
    if (!item || item.kind !== 'message' || item.role !== 'system') break
    splitIndex += 1
  }
  return {
    stablePrefixItems: items.slice(0, splitIndex),
    transcriptTailItems: items.slice(splitIndex),
  }
}

function toToolCall(item: FunctionCallItem): ToolCall {
  return {
    id: item.callId,
    type: 'function',
    function: {
      name: item.name,
      arguments: item.argumentsText,
    },
  }
}

export function functionCallItemsToToolCalls(items: FunctionCallItem[]): ToolCall[] {
  return items.map(toToolCall)
}

export function itemsToMessages(items: ConversationItem[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let pendingAssistant: ChatMessage | null = null
  let pendingAssistantHasContent = false

  const flushAssistant = () => {
    if (!pendingAssistant) return
    if (!pendingAssistantHasContent && pendingAssistant.content === null) {
      delete pendingAssistant.content
    }
    messages.push(pendingAssistant)
    pendingAssistant = null
    pendingAssistantHasContent = false
  }

  for (const item of items) {
    if (item.kind === 'reasoning') continue

    if (item.kind === 'function_call') {
      if (!pendingAssistant) {
        pendingAssistant = {
          role: 'assistant',
          content: null,
          tool_calls: [],
        }
      }
      if (!pendingAssistant.tool_calls) pendingAssistant.tool_calls = []
      pendingAssistant.tool_calls.push(toToolCall(item))
      continue
    }

    flushAssistant()

    if (item.kind === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.callId,
        content: item.outputText,
      })
      continue
    }

    if (item.role === 'assistant') {
      pendingAssistant = {
        role: 'assistant',
        content: item.content,
      }
      pendingAssistantHasContent = item.content.trim() !== ''
      continue
    }

    messages.push({
      role: item.role,
      content: item.content,
    })
  }

  flushAssistant()
  return messages
}

export function assistantResponseToItems(response: AssistantResponse): ConversationItem[] {
  return legacyMessageToItems({
    role: 'assistant',
    content: response.content,
    tool_calls: response.tool_calls,
  })
}

export function findLastAssistantText(items: ConversationItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'message' && item.role === 'assistant') {
      return item.content
    }
  }
  return ''
}

export function countFunctionCallItems(items: ConversationItem[]): number {
  return items.filter((item) => item.kind === 'function_call').length
}

export function createRuntimeUserItem(content: string): UserMessageItem {
  return {
    kind: 'message',
    role: 'user',
    content,
    source: 'runtime',
  }
}

export function createExternalUserItem(content: string): UserMessageItem {
  return {
    kind: 'message',
    role: 'user',
    content,
    source: 'external',
  }
}

export function createSystemItem(content: string, source: 'static' | 'runtime'): SystemMessageItem {
  return {
    kind: 'message',
    role: 'system',
    content,
    source,
  }
}

export function createAssistantItem(content: string): AssistantMessageItem {
  return {
    kind: 'message',
    role: 'assistant',
    content,
    source: 'provider',
  }
}

export function createFunctionCallOutputItem(callId: string, outputText: string, isError?: boolean): FunctionCallOutputItem {
  return {
    kind: 'function_call_output',
    callId,
    outputText,
    isError,
  }
}
