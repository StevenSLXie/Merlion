import type { ToolDefinition } from './tools/types.js'
import type { ConversationItem, ProviderCapabilities, ProviderResult } from './runtime/items.ts'

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
  provider?: string
}

export interface AssistantResponse {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: Usage
}

export interface ModelProvider {
  capabilities?(): ProviderCapabilities
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>
  completeItems?(items: ConversationItem[], tools: ToolDefinition[]): Promise<ProviderResult>
  setMaxOutputTokens?(tokens: number): void
}

export interface LoopState {
  items: ConversationItem[]
  turnCount: number
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  // Times a nudge was injected this session. Capped at 2 to prevent nudge loops.
  nudgeCount: number
}

export type LoopTerminal = 'completed' | 'max_turns_exceeded' | 'model_error'

export interface SessionMetadata {
  id: string
  createdAt: string
  model: string
  projectPath: string
}

export interface SessionMetaEntry extends SessionMetadata {
  type: 'session_meta'
}

export interface TranscriptMessageEntry extends ChatMessage {
  type: 'message'
}

export type TranscriptEntry = SessionMetaEntry | TranscriptMessageEntry
