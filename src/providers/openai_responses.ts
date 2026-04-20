import { randomUUID } from 'node:crypto'

import type { ModelProvider } from '../types.js'
import type {
  AssistantMessageItem,
  ConversationItem,
  FunctionCallItem,
  ProviderCapabilities,
  ProviderResponseBoundary,
  ProviderResult,
  ReasoningItem,
  SystemMessageItem,
  UserMessageItem,
} from '../runtime/items.ts'
import { buildModelToolDescription } from '../tools/model_guidance.ts'
import type { ToolDefinition } from '../tools/types.js'

export interface OpenAIResponsesConfig {
  apiKey: string
  baseURL: string
  model: string
  maxTokens?: number
  store?: boolean
  includeEncryptedReasoning?: boolean
}

function extractCachedTokens(usage: any): number | null {
  const candidates = [
    usage?.cached_tokens,
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.prompt_tokens_details?.cache_read_tokens,
    usage?.cache_read_input_tokens
  ]

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value))
    }
  }
  return null
}

function toApiTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: buildModelToolDescription(tool),
    parameters: tool.parameters,
    strict: false,
  }))
}

function mapMessageItem(item: UserMessageItem | AssistantMessageItem | SystemMessageItem): unknown {
  return {
    type: 'message',
    role: item.role,
    content: [
      {
        type: 'input_text',
        text: item.content,
      }
    ]
  }
}

function mapReasoningItem(item: ReasoningItem): unknown {
  const payload: Record<string, unknown> = { type: 'reasoning' }
  if (item.summaryText) {
    payload.summary = [{ type: 'summary_text', text: item.summaryText }]
  }
  if (item.encryptedContent) payload.encrypted_content = item.encryptedContent
  if (item.itemId) payload.id = item.itemId
  return payload
}

function mapFunctionCallItem(item: FunctionCallItem): unknown {
  return {
    type: 'function_call',
    id: item.itemId,
    call_id: item.callId,
    name: item.name,
    arguments: item.argumentsText,
  }
}

function mapFunctionCallOutputItem(item: Extract<ConversationItem, { kind: 'function_call_output' }>): unknown {
  return {
    type: 'function_call_output',
    call_id: item.callId,
    output: item.outputText,
  }
}

function itemToApiInput(item: ConversationItem): unknown {
  if (item.kind === 'message') return mapMessageItem(item)
  if (item.kind === 'reasoning') return mapReasoningItem(item)
  if (item.kind === 'function_call') return mapFunctionCallItem(item)
  return mapFunctionCallOutputItem(item)
}

function parseOutputMessageContent(content: any[]): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .join('')
}

function fromResponseOutputItem(item: any): ConversationItem[] {
  if (!item || typeof item !== 'object') return []
  if (item.type === 'message') {
    const role = item.role
    const text = parseOutputMessageContent(item.content)
    if (role === 'assistant') {
      return [{
        kind: 'message',
        role: 'assistant',
        content: text,
        source: 'provider',
        itemId: typeof item.id === 'string' ? item.id : undefined,
      }]
    }
    if (role === 'system') {
      return [{
        kind: 'message',
        role: 'system',
        content: text,
        source: 'runtime',
        itemId: typeof item.id === 'string' ? item.id : undefined,
      }]
    }
    return [{
      kind: 'message',
      role: 'user',
      content: text,
      source: 'external',
      itemId: typeof item.id === 'string' ? item.id : undefined,
    }]
  }
  if (item.type === 'reasoning') {
    return [{
      kind: 'reasoning',
      itemId: typeof item.id === 'string' ? item.id : undefined,
      summaryText: Array.isArray(item.summary)
        ? item.summary.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : undefined,
      encryptedContent: typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined,
    }]
  }
  if (item.type === 'function_call') {
    return [{
      kind: 'function_call',
      itemId: typeof item.id === 'string' ? item.id : undefined,
      callId: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? ''),
      name: String(item.name ?? ''),
      argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
    }]
  }
  if (item.type === 'function_call_output') {
    return [{
      kind: 'function_call_output',
      itemId: typeof item.id === 'string' ? item.id : undefined,
      callId: typeof item.call_id === 'string' ? item.call_id : '',
      outputText: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
    }]
  }
  return []
}

function inferFinishReason(json: any, outputItems: ConversationItem[]): ProviderResult['finishReason'] {
  const reason = String(json?.incomplete_details?.reason ?? '')
  if (reason.includes('max_output_tokens') || reason.includes('length')) return 'length'
  if (outputItems.some((item) => item.kind === 'function_call')) return 'tool_calls'
  return 'stop'
}

export class OpenAIResponsesProvider implements ModelProvider {
  private readonly config: OpenAIResponsesConfig
  private maxTokens: number

  constructor(config: OpenAIResponsesConfig) {
    this.config = config
    this.maxTokens = config.maxTokens ?? 8192
  }

  capabilities(): ProviderCapabilities {
    return {
      transcriptMode: 'items',
      supportsReasoningItems: true,
      supportsPreviousResponseId: true,
    }
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxTokens = tokens
  }

  async completeItems(items: ConversationItem[], tools: ToolDefinition[]): Promise<ProviderResult> {
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        input: items.map(itemToApiInput),
        tools: tools.length > 0 ? toApiTools(tools) : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        max_output_tokens: this.maxTokens,
        store: this.config.store ?? false,
        include: this.config.includeEncryptedReasoning ? ['reasoning.encrypted_content'] : undefined,
      })
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Provider error ${response.status}: ${text}`)
    }

    const json = await response.json() as any
    const output = Array.isArray(json.output) ? json.output : []
    const outputItems = output.flatMap((item: any) => fromResponseOutputItem(item))
    const finishReason = inferFinishReason(json, outputItems)
    const boundary: ProviderResponseBoundary = {
      runtimeResponseId: randomUUID(),
      providerResponseId: typeof json.id === 'string' ? json.id : undefined,
      provider: 'openai_responses',
      model: this.config.model,
      finishReason,
      outputItemCount: outputItems.length,
      createdAt: new Date().toISOString(),
    }

    return {
      outputItems,
      finishReason,
      usage: {
        prompt_tokens: json.usage?.input_tokens ?? json.usage?.prompt_tokens ?? 0,
        completion_tokens: json.usage?.output_tokens ?? json.usage?.completion_tokens ?? 0,
        cached_tokens: extractCachedTokens(json.usage),
        provider: 'openai_responses',
      },
      providerResponseId: boundary.providerResponseId,
      responseBoundary: boundary,
    }
  }

  async complete(): Promise<never> {
    throw new Error('OpenAIResponsesProvider does not support complete(messages). Use completeItems(items, tools).')
  }
}
