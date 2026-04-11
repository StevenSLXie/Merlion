import type { AssistantResponse, ChatMessage, ModelProvider } from '../types.js'
import type { ToolDefinition } from '../tools/types.js'

export interface OpenAICompatConfig {
  apiKey: string
  baseURL: string
  model: string
  maxTokens?: number
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
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

export class OpenAICompatProvider implements ModelProvider {
  private readonly config: OpenAICompatConfig
  private maxTokens: number

  constructor(config: OpenAICompatConfig) {
    this.config = config
    this.maxTokens = config.maxTokens ?? 8192
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxTokens = tokens
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: tools.length > 0 ? toApiTools(tools) : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        max_tokens: this.maxTokens,
        stream: false
      })
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Provider error ${response.status}: ${text}`)
    }

    const json = await response.json() as any
    const choice = json.choices?.[0]
    if (!choice?.message) {
      throw new Error('Provider response missing choices[0].message')
    }

    return {
      role: 'assistant',
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
      finish_reason: choice.finish_reason ?? 'stop',
      usage: {
        prompt_tokens: json.usage?.prompt_tokens ?? 0,
        completion_tokens: json.usage?.completion_tokens ?? 0,
        cached_tokens: extractCachedTokens(json.usage)
      }
    }
  }
}
