import { createHash } from 'node:crypto'

import type { ChatMessage } from '../types.js'
import type { ConversationItem } from './items.ts'

export interface PromptRoleTokens {
  system: number
  user: number
  assistant: number
  tool: number
}

export interface PromptObservabilitySnapshot {
  turn: number
  estimated_input_tokens: number
  tool_schema_tokens_estimate: number
  role_tokens: PromptRoleTokens
  role_delta_tokens: PromptRoleTokens
  stable_prefix_tokens: number
  stable_prefix_ratio: number
  stable_prefix_hash: string | null
  runtime_response_id?: string
  provider_response_id?: string
  provider_finish_reason?: string
}

interface PromptTrackerState {
  signatures: string[]
  roleTokens: PromptRoleTokens
  initialized: boolean
}

function isConversationItemArray(value: ChatMessage[] | ConversationItem[]): value is ConversationItem[] {
  return value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'kind' in value[0]!
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

function emptyRoleTokens(): PromptRoleTokens {
  return { system: 0, user: 0, assistant: 0, tool: 0 }
}

function countMessageChars(message: ChatMessage): number {
  let chars = 0
  chars += message.role.length
  if (typeof message.content === 'string') chars += message.content.length
  if (typeof message.name === 'string') chars += message.name.length
  if (typeof message.tool_call_id === 'string') chars += message.tool_call_id.length
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      chars += call.id.length
      chars += call.type.length
      chars += call.function.name.length
      chars += call.function.arguments.length
    }
  }
  return chars
}

function countItemChars(item: ConversationItem): number {
  if (item.kind === 'message') {
    return item.role.length + item.source.length + item.content.length
  }
  if (item.kind === 'function_call') {
    return item.callId.length + item.name.length + item.argumentsText.length
  }
  if (item.kind === 'function_call_output') {
    return item.callId.length + item.outputText.length
  }
  return (item.summaryText?.length ?? 0) + (item.encryptedContent?.length ?? 0)
}

function messageSignature(message: ChatMessage): string {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => `${call.id}|${call.type}|${call.function.name}|${call.function.arguments}`).join('||')
    : ''
  return [
    message.role,
    message.name ?? '',
    message.tool_call_id ?? '',
    typeof message.content === 'string' ? message.content : '',
    toolCalls
  ].join('\n')
}

function itemSignature(item: ConversationItem): string {
  if (item.kind === 'message') {
    return [item.kind, item.role, item.source, item.content, item.itemId ?? ''].join('\n')
  }
  if (item.kind === 'function_call') {
    return [item.kind, item.callId, item.name, item.argumentsText, item.itemId ?? ''].join('\n')
  }
  if (item.kind === 'function_call_output') {
    return [item.kind, item.callId, item.outputText, String(item.isError ?? ''), item.itemId ?? ''].join('\n')
  }
  return [item.kind, item.summaryText ?? '', item.encryptedContent ?? '', item.itemId ?? ''].join('\n')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function stablePrefixCount(previous: string[], current: string[]): number {
  const limit = Math.min(previous.length, current.length)
  let index = 0
  while (index < limit) {
    if (previous[index] !== current[index]) return index
    index += 1
  }
  return limit
}

function roleDelta(current: PromptRoleTokens, previous: PromptRoleTokens): PromptRoleTokens {
  return {
    system: current.system - previous.system,
    user: current.user - previous.user,
    assistant: current.assistant - previous.assistant,
    tool: current.tool - previous.tool,
  }
}

export function createPromptObservabilityTracker() {
  return createPromptObservabilityTrackerWithToolSchema()
}

export function withResponseBoundaryPromptObservability(
  snapshot: PromptObservabilitySnapshot,
  boundary: {
    runtimeResponseId: string
    providerResponseId?: string
    finishReason: string
  }
): PromptObservabilitySnapshot {
  return {
    ...snapshot,
    runtime_response_id: boundary.runtimeResponseId,
    provider_response_id: boundary.providerResponseId,
    provider_finish_reason: boundary.finishReason,
  }
}

export function createPromptObservabilityTrackerWithToolSchema(toolSchemaSerialized?: string) {
  const toolSchemaTokensEstimate = toolSchemaSerialized
    ? estimateTokensFromChars(toolSchemaSerialized.length)
    : 0
  const toolSchemaHash = toolSchemaSerialized ? shortHash(toolSchemaSerialized) : null
  let previousState: PromptTrackerState = {
    signatures: [],
    roleTokens: emptyRoleTokens(),
    initialized: false
  }

  return {
    record(turn: number, input: ChatMessage[] | ConversationItem[]): PromptObservabilitySnapshot {
      const signatures = isConversationItemArray(input)
        ? input.map(itemSignature)
        : input.map(messageSignature)
      const messageTokens = isConversationItemArray(input)
        ? input.map((item) => estimateTokensFromChars(countItemChars(item)))
        : input.map((message) => estimateTokensFromChars(countMessageChars(message)))
      const roleTokens = emptyRoleTokens()

      for (let i = 0; i < input.length; i += 1) {
        const tokens = messageTokens[i]!
        if (isConversationItemArray(input)) {
          const item = input[i]!
          if (item.kind === 'message') {
            if (item.role === 'system') roleTokens.system += tokens
            else if (item.role === 'user') roleTokens.user += tokens
            else roleTokens.assistant += tokens
          } else if (item.kind === 'reasoning') {
            roleTokens.assistant += tokens
          } else {
            roleTokens.tool += tokens
          }
        } else {
          const role = input[i]!.role
          if (role === 'system') roleTokens.system += tokens
          else if (role === 'user') roleTokens.user += tokens
          else if (role === 'assistant') roleTokens.assistant += tokens
          else roleTokens.tool += tokens
        }
      }

      const estimatedInputTokens =
        roleTokens.system + roleTokens.user + roleTokens.assistant + roleTokens.tool + toolSchemaTokensEstimate
      const stableCount = stablePrefixCount(previousState.signatures, signatures)
      const stableMessageTokens = messageTokens.slice(0, stableCount).reduce((sum, value) => sum + value, 0)
      const stableTokens =
        previousState.initialized
          ? stableMessageTokens + toolSchemaTokensEstimate
          : 0
      const stableHash =
        previousState.initialized && (stableCount > 0 || toolSchemaHash !== null)
          ? shortHash([
              toolSchemaHash ?? '',
              signatures.slice(0, stableCount).join('\n---\n')
            ].join('\n===\n'))
          : null
      const ratio = estimatedInputTokens > 0 ? stableTokens / estimatedInputTokens : 0

      const snapshot: PromptObservabilitySnapshot = {
        turn,
        estimated_input_tokens: estimatedInputTokens,
        tool_schema_tokens_estimate: toolSchemaTokensEstimate,
        role_tokens: roleTokens,
        role_delta_tokens: roleDelta(roleTokens, previousState.roleTokens),
        stable_prefix_tokens: stableTokens,
        stable_prefix_ratio: ratio,
        stable_prefix_hash: stableHash
      }

      previousState = {
        signatures,
        roleTokens,
        initialized: true
      }
      return snapshot
    }
  }
}
