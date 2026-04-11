import type { ToolDefinition } from './tools/types.js'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatMessage {
  role: Role
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens?: number | null
}

export interface AssistantResponse {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: Usage
}

export interface ModelProvider {
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>
  setMaxOutputTokens?(tokens: number): void
}

export interface LoopState {
  messages: ChatMessage[]
  turnCount: number
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  // Times a nudge was injected this session. Capped at 2 to prevent nudge loops.
  nudgeCount: number
}

export type LoopTerminal = 'completed' | 'max_turns_exceeded' | 'model_error'
