import { createHash } from 'node:crypto'

import type { ChatMessage } from '../types.js'

export interface PromptRoleTokens {
  system: number
  user: number
  assistant: number
  tool: number
}

export interface PromptObservabilitySnapshot {
  turn: number
  estimated_input_tokens: number
  role_tokens: PromptRoleTokens
  role_delta_tokens: PromptRoleTokens
  stable_prefix_tokens: number
  stable_prefix_ratio: number
  stable_prefix_hash: string | null
}

interface PromptTrackerState {
  signatures: string[]
  roleTokens: PromptRoleTokens
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
  let previousState: PromptTrackerState = {
    signatures: [],
    roleTokens: emptyRoleTokens()
  }

  return {
    record(turn: number, messages: ChatMessage[]): PromptObservabilitySnapshot {
      const signatures = messages.map(messageSignature)
      const messageTokens = messages.map((message) => estimateTokensFromChars(countMessageChars(message)))
      const roleTokens = emptyRoleTokens()

      for (let i = 0; i < messages.length; i += 1) {
        const role = messages[i]!.role
        const tokens = messageTokens[i]!
        if (role === 'system') roleTokens.system += tokens
        else if (role === 'user') roleTokens.user += tokens
        else if (role === 'assistant') roleTokens.assistant += tokens
        else roleTokens.tool += tokens
      }

      const estimatedInputTokens = roleTokens.system + roleTokens.user + roleTokens.assistant + roleTokens.tool
      const stableCount = stablePrefixCount(previousState.signatures, signatures)
      const stableTokens = messageTokens.slice(0, stableCount).reduce((sum, value) => sum + value, 0)
      const stableHash = stableCount > 0 ? shortHash(signatures.slice(0, stableCount).join('\n---\n')) : null
      const ratio = estimatedInputTokens > 0 ? stableTokens / estimatedInputTokens : 0

      const snapshot: PromptObservabilitySnapshot = {
        turn,
        estimated_input_tokens: estimatedInputTokens,
        role_tokens: roleTokens,
        role_delta_tokens: roleDelta(roleTokens, previousState.roleTokens),
        stable_prefix_tokens: stableTokens,
        stable_prefix_ratio: ratio,
        stable_prefix_hash: stableHash
      }

      previousState = {
        signatures,
        roleTokens
      }
      return snapshot
    }
  }
}
