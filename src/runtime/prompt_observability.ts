import { createHash } from 'node:crypto'

import type { ConversationItem } from './items.ts'
import type { ToolDefinition } from '../tools/types.js'
import { serializeToolSchema } from '../tools/registry.ts'
import type { SchemaChangeReason } from './task_state.ts'

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
  tool_schema_hash: string | null
  schema_change_reason: SchemaChangeReason | null
  overlay_tokens_estimate: number
  role_tokens: PromptRoleTokens
  role_delta_tokens: PromptRoleTokens
  stable_prefix_tokens: number
  stable_prefix_ratio: number
  stable_prefix_hash: string | null
  runtime_response_id?: string
  provider_response_id?: string
  provider_finish_reason?: string
}

export interface ToolSchemaObservabilitySummary {
  tool_count: number
  tool_schema_serialized: string
  tool_schema_serialized_chars: number
  tool_schema_tokens_estimate: number
}

interface PromptTrackerState {
  signatures: string[]
  roleTokens: PromptRoleTokens
  toolSchemaHash: string | null
  initialized: boolean
}

export interface PromptObservabilityRecordInput {
  stablePrefixItems: ConversationItem[]
  overlayItems: ConversationItem[]
  transcriptItems: ConversationItem[]
  tools?: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>
  schemaChangeReason?: SchemaChangeReason | null
}

export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

export function summarizeToolSchema(
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>
): ToolSchemaObservabilitySummary {
  const toolSchemaSerialized = serializeToolSchema(tools)
  return {
    tool_count: tools.length,
    tool_schema_serialized: toolSchemaSerialized,
    tool_schema_serialized_chars: toolSchemaSerialized.length,
    tool_schema_tokens_estimate: estimateTokensFromChars(toolSchemaSerialized.length),
  }
}

function summarizeSerializedToolSchema(toolSchemaSerialized: string): ToolSchemaObservabilitySummary {
  return {
    tool_count: 0,
    tool_schema_serialized: toolSchemaSerialized,
    tool_schema_serialized_chars: toolSchemaSerialized.length,
    tool_schema_tokens_estimate: estimateTokensFromChars(toolSchemaSerialized.length),
  }
}

function emptyRoleTokens(): PromptRoleTokens {
  return { system: 0, user: 0, assistant: 0, tool: 0 }
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
  const fallbackToolSchema = toolSchemaSerialized
    ? summarizeSerializedToolSchema(toolSchemaSerialized)
    : null
  let previousState: PromptTrackerState = {
    signatures: [],
    roleTokens: emptyRoleTokens(),
    toolSchemaHash: null,
    initialized: false
  }

  return {
    record(
      turn: number,
      input: ConversationItem[] | PromptObservabilityRecordInput,
    ): PromptObservabilitySnapshot {
      const assembly = Array.isArray(input)
        ? {
            requestItems: [...input],
            nonOverlayItems: [...input],
            overlayItems: [] as ConversationItem[],
            toolSchema: fallbackToolSchema,
            schemaChangeReason: null,
          }
        : {
            requestItems: [
              ...input.stablePrefixItems,
              ...input.overlayItems,
              ...input.transcriptItems,
            ],
            nonOverlayItems: [
              ...input.stablePrefixItems,
              ...input.transcriptItems,
            ],
            overlayItems: [...input.overlayItems],
            toolSchema: input.tools ? summarizeToolSchema(input.tools) : fallbackToolSchema,
            schemaChangeReason: input.schemaChangeReason ?? null,
          }

      const toolSchemaTokensEstimate = assembly.toolSchema?.tool_schema_tokens_estimate ?? 0
      const toolSchemaHash = assembly.toolSchema
        ? shortHash(assembly.toolSchema.tool_schema_serialized)
        : null
      const requestSignatures = assembly.nonOverlayItems.map(itemSignature)
      const requestTokens = assembly.requestItems.map((item) => estimateTokensFromChars(countItemChars(item)))
      const nonOverlayTokens = assembly.nonOverlayItems.map((item) => estimateTokensFromChars(countItemChars(item)))
      const overlayTokensEstimate = assembly.overlayItems
        .map((item) => estimateTokensFromChars(countItemChars(item)))
        .reduce((sum, value) => sum + value, 0)
      const roleTokens = emptyRoleTokens()

      for (let i = 0; i < assembly.requestItems.length; i += 1) {
        const tokens = requestTokens[i]!
        const item = assembly.requestItems[i]!
        if (item.kind === 'message') {
          if (item.role === 'system') roleTokens.system += tokens
          else if (item.role === 'user') roleTokens.user += tokens
          else roleTokens.assistant += tokens
        } else if (item.kind === 'reasoning') {
          roleTokens.assistant += tokens
        } else {
          roleTokens.tool += tokens
        }
      }

      const estimatedInputTokens =
        roleTokens.system + roleTokens.user + roleTokens.assistant + roleTokens.tool + toolSchemaTokensEstimate
      const nonOverlayEstimatedInputTokens = Math.max(0, estimatedInputTokens - overlayTokensEstimate)
      const stableCount = stablePrefixCount(previousState.signatures, requestSignatures)
      const stableMessageTokens = nonOverlayTokens.slice(0, stableCount).reduce((sum, value) => sum + value, 0)
      const stableToolSchemaTokens =
        previousState.initialized && previousState.toolSchemaHash !== null && previousState.toolSchemaHash === toolSchemaHash
          ? toolSchemaTokensEstimate
          : 0
      const stableTokens =
        previousState.initialized
          ? stableMessageTokens + stableToolSchemaTokens
          : 0
      const stableHash =
        previousState.initialized && (stableCount > 0 || stableToolSchemaTokens > 0)
          ? shortHash([
              stableToolSchemaTokens > 0 ? (toolSchemaHash ?? '') : '',
              requestSignatures.slice(0, stableCount).join('\n---\n')
            ].join('\n===\n'))
          : null
      const ratio = nonOverlayEstimatedInputTokens > 0 ? stableTokens / nonOverlayEstimatedInputTokens : 0

      const snapshot: PromptObservabilitySnapshot = {
        turn,
        estimated_input_tokens: estimatedInputTokens,
        tool_schema_tokens_estimate: toolSchemaTokensEstimate,
        tool_schema_hash: toolSchemaHash,
        schema_change_reason: assembly.schemaChangeReason,
        overlay_tokens_estimate: overlayTokensEstimate,
        role_tokens: roleTokens,
        role_delta_tokens: roleDelta(roleTokens, previousState.roleTokens),
        stable_prefix_tokens: stableTokens,
        stable_prefix_ratio: ratio,
        stable_prefix_hash: stableHash
      }

      previousState = {
        signatures: requestSignatures,
        roleTokens,
        toolSchemaHash,
        initialized: true
      }
      return snapshot
    }
  }
}
