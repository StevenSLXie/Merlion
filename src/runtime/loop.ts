import type { ChatMessage, LoopState, LoopTerminal, ModelProvider } from '../types.js'
import type { PermissionStore, ToolContext } from '../tools/types.js'
import { executeToolCalls } from './executor.ts'
import { ToolRegistry } from '../tools/registry.ts'

export interface RunLoopOptions {
  provider: ModelProvider
  registry: ToolRegistry
  systemPrompt: string
  userPrompt: string
  cwd: string
  permissions?: PermissionStore
  maxTurns?: number
  initialMessages?: ChatMessage[]
  persistInitialMessages?: boolean
  onMessageAppended?: (message: ChatMessage) => Promise<void> | void
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => Promise<void> | void
}

export interface RunLoopResult {
  terminal: LoopTerminal
  finalText: string
  state: LoopState
}

function createState(systemPrompt: string, userPrompt: string, initialMessages?: ChatMessage[]): LoopState {
  const messages: ChatMessage[] = initialMessages
    ? [...initialMessages]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

  if (initialMessages && userPrompt.trim() !== '') {
    messages.push({ role: 'user', content: userPrompt })
  }

  return {
    messages,
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0
  }
}

export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const state = createState(options.systemPrompt, options.userPrompt, options.initialMessages)
  const maxTurns = options.maxTurns ?? 100
  let finalText = ''

  const defaultPermissions: PermissionStore = { ask: async () => 'allow' }
  const toolContext: ToolContext = {
    cwd: options.cwd,
    permissions: options.permissions ?? defaultPermissions
  }

  if (options.persistInitialMessages !== false) {
    for (const initialMessage of state.messages) {
      await options.onMessageAppended?.(initialMessage)
    }
  }

  for (;;) {
    if (state.turnCount >= maxTurns) {
      return { terminal: 'max_turns_exceeded', finalText, state }
    }

    let assistant
    try {
      assistant = await options.provider.complete(state.messages, options.registry.getAll())
    } catch {
      return { terminal: 'model_error', finalText, state }
    }

    state.turnCount += 1
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistant.content,
      tool_calls: assistant.tool_calls
    }
    state.messages.push(assistantMessage)
    await options.onMessageAppended?.(assistantMessage)
    await options.onUsage?.(assistant.usage)

    if (assistant.finish_reason === 'tool_calls' && assistant.tool_calls && assistant.tool_calls.length > 0) {
      const maxConcurrency = Number(process.env.MERLION_MAX_TOOL_CONCURRENCY ?? '10')
      const toolMessages = await executeToolCalls({
        toolCalls: assistant.tool_calls,
        registry: options.registry,
        toolContext,
        maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 10
      })

      for (const toolMsg of toolMessages) {
        state.messages.push(toolMsg)
        await options.onMessageAppended?.(toolMsg)
      }
      continue
    }

    if (assistant.finish_reason === 'length' && state.maxOutputTokensRecoveryCount < 3) {
      state.maxOutputTokensRecoveryCount += 1
      const continueMessage: ChatMessage = {
        role: 'user',
        content: 'Output was cut off. Continue directly from where you stopped. No recap, no apology.'
      }
      state.messages.push(continueMessage)
      await options.onMessageAppended?.(continueMessage)
      continue
    }

    finalText = assistant.content ?? ''
    return { terminal: 'completed', finalText, state }
  }
}
