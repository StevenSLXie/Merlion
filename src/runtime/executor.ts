import type { ChatMessage, ToolCall } from '../types.js'
import type { ToolContext } from '../tools/types.js'
import { ToolRegistry } from '../tools/registry.ts'

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
): Promise<ChatMessage> {
  const tool = registry.get(call.function.name)
  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `Unknown tool: ${call.function.name}`
    }
  }
  const args = parseToolArgs(call.function.arguments)
  const result = await tool.execute(args, toolContext)
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: result.content && result.content.trim() !== '' ? result.content : '(no output)'
  }
}

async function executeSafeBatch(
  batch: ToolCall[],
  registry: ToolRegistry,
  toolContext: ToolContext,
  maxConcurrency: number,
): Promise<ChatMessage[]> {
  const results: ChatMessage[] = new Array(batch.length)
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= batch.length) return
      results[index] = await runToolCall(batch[index]!, registry, toolContext)
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
}

export async function executeToolCalls(options: ExecuteToolCallsOptions): Promise<ChatMessage[]> {
  const { toolCalls, registry, toolContext } = options
  const batches = partitionToolCalls(toolCalls, registry)
  const resultsById = new Map<string, ChatMessage>()

  for (const batch of batches) {
    if (batch.length === 0) continue
    const safe = batch.every((call) => isConcurrencySafe(call, registry))
    const batchResults = safe
      ? await executeSafeBatch(batch, registry, toolContext, options.maxConcurrency)
      : [await runToolCall(batch[0]!, registry, toolContext)]

    for (const message of batchResults) {
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

