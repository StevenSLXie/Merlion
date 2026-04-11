import type { ChatMessage, LoopState, LoopTerminal, ModelProvider } from '../types.js'
import type { PermissionStore, ToolContext } from '../tools/types.js'
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

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
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
      for (const call of assistant.tool_calls) {
        const tool = options.registry.get(call.function.name)
        if (!tool) {
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: `Unknown tool: ${call.function.name}`
          }
          state.messages.push(toolMsg)
          await options.onMessageAppended?.(toolMsg)
          continue
        }

        const args = parseToolArgs(call.function.arguments)
        const result = await tool.execute(args, toolContext)
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: result.content && result.content.trim() !== '' ? result.content : '(no output)'
        }
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
