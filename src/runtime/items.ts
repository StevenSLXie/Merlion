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

export interface CanonicalRequestAssembly {
  stablePrefixItems: ConversationItem[]
  overlayItems: ConversationItem[]
  transcriptItems: ConversationItem[]
  requestItems: ConversationItem[]
}

export interface CanonicalRequestAssemblyInput {
  stablePrefixItems: ConversationItem[]
  promptPreludeItems?: ConversationItem[]
  executionCharterText?: string
  runtimeOverlayItems?: ConversationItem[]
  transcriptItems: ConversationItem[]
  intentContract?: string
}

type CanonicalOverlayKind =
  | 'target_paths'
  | 'prompt_path_guidance'
  | 'execution_charter'
  | 'tool_path_guidance'
  | 'tool_argument_hint'
  | 'tool_error_hint'
  | 'no_progress_hint'
  | 'mutation_oscillation_hint'
  | 'large_diff_hint'
  | 'overwrite_after_edit_hint'
  | 'test_first_bugfix_hint'
  | 'exploration_budget_hint'
  | 'no_mutation_hint'
  | 'todo_drift_hint'
  | 'max_output_recovery'
  | 'post_tool_summary'
  | 'no_mutation_stop'
  | 'verification_hint'
  | 'continue_task_hint'
  | 'natural_summary_request'
  | 'intent_contract'
  | 'runtime_system_other'
  | 'runtime_user_other'
  | 'overlay_other'

type OverlayMessageDescriptor = {
  kind: CanonicalOverlayKind
  order: number
  pattern: RegExp
}

const RUNTIME_SYSTEM_OVERLAY_DESCRIPTORS: OverlayMessageDescriptor[] = [
  { kind: 'target_paths', order: 100, pattern: /^User-specified target paths detected\./i },
  { kind: 'prompt_path_guidance', order: 110, pattern: /^Prompt-derived path guidance\./i },
  { kind: 'execution_charter', order: 200, pattern: /^Execution charter for this turn:/i },
  { kind: 'tool_path_guidance', order: 300, pattern: /^Path guidance update\./i },
  { kind: 'intent_contract', order: 900, pattern: /^Execution contract for the current request\./i },
]

const RUNTIME_USER_OVERLAY_DESCRIPTORS: OverlayMessageDescriptor[] = [
  { kind: 'tool_argument_hint', order: 400, pattern: /^Tool arguments were invalid for /i },
  { kind: 'tool_error_hint', order: 410, pattern: /^Repeated tool failure detected:/i },
  { kind: 'no_progress_hint', order: 420, pattern: /^No progress detected:/i },
  { kind: 'mutation_oscillation_hint', order: 430, pattern: /^Mutation oscillation detected /i },
  { kind: 'large_diff_hint', order: 440, pattern: /^Large patch self-review:/i },
  { kind: 'overwrite_after_edit_hint', order: 450, pattern: /^Overwrite-after-edit guardrail:/i },
  { kind: 'test_first_bugfix_hint', order: 460, pattern: /^Bug-fix guardrail:/i },
  { kind: 'exploration_budget_hint', order: 470, pattern: /^Exploration budget exceeded:/i },
  { kind: 'no_mutation_hint', order: 480, pattern: /^(Bug-fix convergence:|No material progress detected:)/i },
  { kind: 'todo_drift_hint', order: 490, pattern: /^Todo drift detected:/i },
  { kind: 'max_output_recovery', order: 500, pattern: /^Output was cut off\. Continue directly from where you stopped\./i },
  { kind: 'post_tool_summary', order: 510, pattern: /^You just finished tool execution\. Please provide a natural-language final summary/i },
  { kind: 'no_mutation_stop', order: 520, pattern: /^You have not made any successful file changes yet\. Do not finish now\./i },
  { kind: 'verification_hint', order: 530, pattern: /^Before concluding a code-change task, provide validation evidence\./i },
  { kind: 'continue_task_hint', order: 540, pattern: /^Continue with the task\. Use your tools to make progress\./i },
  { kind: 'natural_summary_request', order: 550, pattern: /^Write a natural-language summary of what you completed in this run\./i },
]

type CanonicalOverlayDescriptor = {
  kind: CanonicalOverlayKind
  order: number
  item: ConversationItem
  sortKey: string
  dedupeKey: string
}

function normalizeContent(content: string | null | undefined): string {
  return typeof content === 'string' ? content : ''
}

function isBlank(value: string | null | undefined): boolean {
  return normalizeContent(value).trim() === ''
}

function classifyLegacyUserMessage(content: string): 'external' | 'runtime' {
  if (matchOverlayDescriptor(content, RUNTIME_USER_OVERLAY_DESCRIPTORS)) return 'runtime'
  return 'external'
}

function isLegacyRuntimeUserMessage(content: string): boolean {
  return classifyLegacyUserMessage(content) === 'runtime'
}

function isNonPersistentRuntimeSystemMessage(content: string): boolean {
  return matchOverlayDescriptor(content, RUNTIME_SYSTEM_OVERLAY_DESCRIPTORS) !== null
}

function normalizeItemContent(content: string | null | undefined): string {
  return normalizeContent(content).replace(/\r\n/g, '\n').trim()
}

function matchOverlayDescriptor(
  content: string,
  descriptors: OverlayMessageDescriptor[],
): OverlayMessageDescriptor | null {
  const normalized = normalizeItemContent(content)
  for (const descriptor of descriptors) {
    if (descriptor.pattern.test(normalized)) return descriptor
  }
  return null
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function createIntentContractItem(intentContract: string): SystemMessageItem {
  return createSystemItem(
    'Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\n' +
      intentContract,
    'runtime',
  )
}

function createCanonicalOverlayDescriptor(item: ConversationItem): CanonicalOverlayDescriptor | null {
  if (item.kind !== 'message') {
    const sortKey = stableSerialize(item)
    return {
      kind: 'overlay_other',
      order: 800,
      item: { ...item },
      sortKey,
      dedupeKey: `${item.kind}:${sortKey}`,
    }
  }

  const normalizedContent = normalizeItemContent(item.content)
  if (normalizedContent === '') return null

  const normalizedItem: ConversationItem =
    item.role === 'system'
      ? createSystemItem(normalizedContent, item.source)
      : item.role === 'user'
        ? item.source === 'runtime'
          ? createRuntimeUserItem(normalizedContent)
          : createExternalUserItem(normalizedContent)
        : createAssistantItem(normalizedContent)

  if (normalizedItem.role === 'system' && normalizedItem.source === 'runtime') {
    const descriptor = matchOverlayDescriptor(normalizedContent, RUNTIME_SYSTEM_OVERLAY_DESCRIPTORS)
    return {
      kind: descriptor?.kind ?? 'runtime_system_other',
      order: descriptor?.order ?? 350,
      item: normalizedItem,
      sortKey: normalizedContent,
      dedupeKey: `system:${normalizedItem.source}:${descriptor?.kind ?? 'runtime_system_other'}:${normalizedContent}`,
    }
  }

  if (normalizedItem.role === 'user' && normalizedItem.source === 'runtime') {
    const descriptor = matchOverlayDescriptor(normalizedContent, RUNTIME_USER_OVERLAY_DESCRIPTORS)
    return {
      kind: descriptor?.kind ?? 'runtime_user_other',
      order: descriptor?.order ?? 600,
      item: normalizedItem,
      sortKey: normalizedContent,
      dedupeKey: `user:${normalizedItem.source}:${descriptor?.kind ?? 'runtime_user_other'}:${normalizedContent}`,
    }
  }

  return {
    kind: 'overlay_other',
    order: 800,
    item: normalizedItem,
    sortKey: normalizedContent,
    dedupeKey: `${normalizedItem.role}:${'source' in normalizedItem ? normalizedItem.source : 'unknown'}:${normalizedContent}`,
  }
}

export function buildCanonicalOverlayItems(input: Omit<CanonicalRequestAssemblyInput, 'stablePrefixItems' | 'transcriptItems'>): ConversationItem[] {
  const descriptors: CanonicalOverlayDescriptor[] = []
  if (Array.isArray(input.promptPreludeItems)) {
    for (const item of input.promptPreludeItems) {
      const descriptor = createCanonicalOverlayDescriptor(item)
      if (descriptor) descriptors.push(descriptor)
    }
  }

  const charterText = normalizeItemContent(input.executionCharterText)
  if (charterText !== '') {
    descriptors.push(createCanonicalOverlayDescriptor(createSystemItem(charterText, 'runtime'))!)
  }

  if (Array.isArray(input.runtimeOverlayItems)) {
    for (const item of input.runtimeOverlayItems) {
      const descriptor = createCanonicalOverlayDescriptor(item)
      if (descriptor) descriptors.push(descriptor)
    }
  }

  const intentContract = normalizeItemContent(input.intentContract)
  if (intentContract !== '') {
    descriptors.push(createCanonicalOverlayDescriptor(createIntentContractItem(intentContract))!)
  }

  descriptors.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.sortKey.localeCompare(b.sortKey)
  })

  const overlayItems: ConversationItem[] = []
  const seen = new Set<string>()
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.dedupeKey)) continue
    seen.add(descriptor.dedupeKey)
    overlayItems.push(descriptor.item)
  }
  return overlayItems
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

export function buildCanonicalRequestAssembly(input: CanonicalRequestAssemblyInput): CanonicalRequestAssembly {
  const overlayItems = buildCanonicalOverlayItems(input)
  return {
    stablePrefixItems: [...input.stablePrefixItems],
    overlayItems,
    transcriptItems: [...input.transcriptItems],
    requestItems: [
      ...input.stablePrefixItems,
      ...overlayItems,
      ...input.transcriptItems,
    ],
  }
}
