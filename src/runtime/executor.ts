import type { ChatMessage, ToolCall } from '../types.js'
import type { ToolContext, ToolUiPayload } from '../tools/types.js'
import { ToolRegistry } from '../tools/registry.ts'
import { applyToolResultBudget, resolveToolResultBudgetFromEnv } from './budget.ts'

interface ToolExecutionResult {
  message: ChatMessage
  isError: boolean
  uiPayload?: ToolUiPayload
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function isConcurrencySafe(call: ToolCall, registry: ToolRegistry): boolean {
  const tool = registry.get(call.function.name)
  return tool?.concurrencySafe === true
}

export function partitionToolCalls(toolCalls: ToolCall[], registry: ToolRegistry): ToolCall[][] {
  const batches: ToolCall[][] = []
  let currentSafeBatch: ToolCall[] = []

  for (const call of toolCalls) {
    if (isConcurrencySafe(call, registry)) {
      currentSafeBatch.push(call)
      continue
    }

    if (currentSafeBatch.length > 0) {
      batches.push(currentSafeBatch)
      currentSafeBatch = []
    }
    batches.push([call])
  }

  if (currentSafeBatch.length > 0) {
    batches.push(currentSafeBatch)
  }
  return batches
}

async function runToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  toolContext: ToolContext,
): Promise<ToolExecutionResult> {
  const tool = registry.get(call.function.name)
  if (!tool) {
    return {
      message: {
        role: 'tool',
        tool_call_id: call.id,
        content: `Unknown tool: ${call.function.name}`
      },
      isError: true
    }
  }
  const args = parseToolArgs(call.function.arguments)
  const result = await tool.execute(args, toolContext)
  const budget = resolveToolResultBudgetFromEnv()
  const budgeted = applyToolResultBudget(result.content, budget)
  const content =
    budgeted.truncated
      ? `${budgeted.content}\n[tool result truncated by budget]`
      : budgeted.content
  return {
    message: {
      role: 'tool',
      tool_call_id: call.id,
      content: content && content.trim() !== '' ? content : '(no output)'
    },
    isError: result.isError,
    uiPayload: result.uiPayload
  }
}

export interface ToolCallStartEvent {
  call: ToolCall
  index: number
  total: number
}

export interface ToolCallResultEvent extends ToolCallStartEvent {
  message: ChatMessage
  isError: boolean
  durationMs: number
  uiPayload?: ToolUiPayload
}

async function executeSafeBatch(
  batch: ToolCall[],
  registry: ToolRegistry,
  toolContext: ToolContext,
  maxConcurrency: number,
  indexById: Map<string, number>,
  total: number,
  onToolCallStart?: (event: ToolCallStartEvent) => Promise<void> | void,
  onToolCallResult?: (event: ToolCallResultEvent) => Promise<void> | void,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = new Array(batch.length)
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= batch.length) return
      const call = batch[index]!
      const displayIndex = indexById.get(call.id) ?? index + 1
      await onToolCallStart?.({ call, index: displayIndex, total })
      const startedAt = Date.now()
      const outcome = await runToolCall(call, registry, toolContext)
      const durationMs = Date.now() - startedAt
      results[index] = outcome
      await onToolCallResult?.({
        call,
        index: displayIndex,
        total,
        message: outcome.message,
        isError: outcome.isError,
        durationMs,
        uiPayload: outcome.uiPayload
      })
    }
  }

  const workerCount = Math.max(1, Math.min(maxConcurrency, batch.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export interface ExecuteToolCallsOptions {
  toolCalls: ToolCall[]
  registry: ToolRegistry
  toolContext: ToolContext
  maxConcurrency: number
  onToolCallStart?: (event: ToolCallStartEvent) => Promise<void> | void
  onToolCallResult?: (event: ToolCallResultEvent) => Promise<void> | void
}

export async function executeToolCalls(options: ExecuteToolCallsOptions): Promise<ChatMessage[]> {
  const { toolCalls, registry, toolContext } = options
  const batches = partitionToolCalls(toolCalls, registry)
  const total = toolCalls.length
  const indexById = new Map<string, number>()
  toolCalls.forEach((call, i) => indexById.set(call.id, i + 1))
  const resultsById = new Map<string, ChatMessage>()

  for (const batch of batches) {
    if (batch.length === 0) continue
    const safe = batch.every((call) => isConcurrencySafe(call, registry))
    const batchResults: ToolExecutionResult[] = safe
      ? await executeSafeBatch(
          batch,
          registry,
          toolContext,
          options.maxConcurrency,
          indexById,
          total,
          options.onToolCallStart,
          options.onToolCallResult
        )
      : await (async () => {
          const call = batch[0]!
          const index = indexById.get(call.id) ?? 1
          await options.onToolCallStart?.({ call, index, total })
          const startedAt = Date.now()
          const outcome = await runToolCall(call, registry, toolContext)
          const durationMs = Date.now() - startedAt
          await options.onToolCallResult?.({
            call,
            index,
            total,
            message: outcome.message,
            isError: outcome.isError,
            durationMs,
            uiPayload: outcome.uiPayload
          })
          return [outcome]
        })()

    for (const { message } of batchResults) {
      if (message.tool_call_id) {
        resultsById.set(message.tool_call_id, message)
      }
    }
  }

  return toolCalls.map((call) => (
    resultsById.get(call.id) ?? {
      role: 'tool',
      tool_call_id: call.id,
      content: '[Tool execution missing result]'
    }
  ))
}
