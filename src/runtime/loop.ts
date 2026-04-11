import type { ChatMessage, LoopState, LoopTerminal, ModelProvider } from '../types.js'
import type { PermissionStore, ToolContext } from '../tools/types.js'
import { executeToolCalls, type ToolCallResultEvent, type ToolCallStartEvent } from './executor.ts'
import { withRetry } from './retry.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { compactMessages, estimateMessagesChars } from '../context/compact.ts'

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
  onUsage?: (usage: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
    provider?: string
  }) => Promise<void> | void
  onTurnStart?: (event: { turn: number }) => Promise<void> | void
  onAssistantResponse?: (event: {
    turn: number
    finish_reason: string
    tool_calls_count: number
    content: string | null
  }) => Promise<void> | void
  onToolCallStart?: (event: ToolCallStartEvent) => Promise<void> | void
  onToolCallResult?: (event: ToolCallResultEvent) => Promise<void> | void
}

export interface RunLoopResult {
  terminal: LoopTerminal
  finalText: string
  state: LoopState
}

// Patterns that signal the model promised action but made no tool calls.
// Only tested on responses ≥50 chars to avoid flagging conversational short replies.
const WILL_DO_PATTERNS: RegExp[] = [
  /\bi('ll| will)\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
  /\blet me\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
  /\bi('m| am) going to\s+\w/i,
  /\bfirst,?\s+i('ll| will)\s+\w/i,
  /\bto (start|begin|proceed),?\s+i('ll| will)\s+\w/i,
]

/**
 * Returns true when the model's response looks like a false start:
 * it promised to take action but produced no tool calls.
 *
 * Deliberately conservative to avoid nudging genuine short completions
 * ("done", "在", "yes") or complete summaries.
 */
export function shouldNudge(text: string, state: LoopState): boolean {
  // Hard cap: never nudge more than twice per session
  if (state.nudgeCount >= 2) return false

  // Very short text is always conversational — never nudge
  // "在", "done", "ok", "yes", "finished", etc.
  if (text.trim().length < 50) return false

  // Core signal: contains a "will do X" promise without having done X
  return WILL_DO_PATTERNS.some((p) => p.test(text))
}

function createState(
  systemPrompt: string,
  userPrompt: string,
  initialMessages?: ChatMessage[],
): LoopState {
  const messages: ChatMessage[] = initialMessages
    ? [...initialMessages]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]

  if (initialMessages && userPrompt.trim() !== '') {
    messages.push({ role: 'user', content: userPrompt })
  }

  return {
    messages,
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0,
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const value = Math.floor(parsed)
  return value > 0 ? value : fallback
}

export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const state = createState(options.systemPrompt, options.userPrompt, options.initialMessages)
  const maxTurns = options.maxTurns ?? 100
  let finalText = ''
  let emptyStopRecoveryCount = 0
  let awaitingPostToolSummary = false

  const defaultPermissions: PermissionStore = { ask: async () => 'allow' }
  const toolContext: ToolContext = {
    cwd: options.cwd,
    permissions: options.permissions ?? defaultPermissions,
  }

  if (options.persistInitialMessages !== false) {
    for (const msg of state.messages) {
      await options.onMessageAppended?.(msg)
    }
  }

  for (;;) {
    if (state.turnCount >= maxTurns) {
      return { terminal: 'max_turns_exceeded', finalText, state }
    }

    let assistant
    try {
      const compactTriggerChars = parsePositiveInt(process.env.MERLION_COMPACT_TRIGGER_CHARS, 60_000)
      const keepRecent = parsePositiveInt(process.env.MERLION_COMPACT_KEEP_RECENT, 10)
      const chars = estimateMessagesChars(state.messages)
      if (chars > compactTriggerChars && !state.hasAttemptedReactiveCompact) {
        const compacted = compactMessages(state.messages, { keepRecent })
        if (compacted.compacted) {
          state.messages = compacted.messages
          state.hasAttemptedReactiveCompact = true
        }
      }
      await options.onTurnStart?.({ turn: state.turnCount + 1 })
      assistant = await withRetry(
        () => options.provider.complete(state.messages, options.registry.getAll()),
        { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 32_000 },
      )
    } catch {
      return { terminal: 'model_error', finalText, state }
    }

    state.turnCount += 1

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistant.content,
      tool_calls: assistant.tool_calls,
    }
    state.messages.push(assistantMessage)
    await options.onMessageAppended?.(assistantMessage)
    await options.onUsage?.(assistant.usage)
    await options.onAssistantResponse?.({
      turn: state.turnCount,
      finish_reason: assistant.finish_reason,
      tool_calls_count: assistant.tool_calls?.length ?? 0,
      content: assistant.content
    })

    // ── tool_calls ──────────────────────────────────────────────────────────
    if (
      assistant.finish_reason === 'tool_calls' &&
      assistant.tool_calls &&
      assistant.tool_calls.length > 0
    ) {
      const maxConcurrency = Number(process.env.MERLION_MAX_TOOL_CONCURRENCY ?? '10')
      const toolMessages = await executeToolCalls({
        toolCalls: assistant.tool_calls,
        registry: options.registry,
        toolContext,
        maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 10,
        onToolCallStart: options.onToolCallStart,
        onToolCallResult: options.onToolCallResult,
      })

      for (const toolMsg of toolMessages) {
        state.messages.push(toolMsg)
        await options.onMessageAppended?.(toolMsg)
      }
      continue
    }

    // ── length (output truncated) ────────────────────────────────────────────
    if (assistant.finish_reason === 'length' && state.maxOutputTokensRecoveryCount < 3) {
      state.maxOutputTokensRecoveryCount += 1
      const continueMessage: ChatMessage = {
        role: 'user',
        content: 'Output was cut off. Continue directly from where you stopped. No recap, no apology.',
      }
      state.messages.push(continueMessage)
      await options.onMessageAppended?.(continueMessage)
      continue
    }

    // ── content_filter ───────────────────────────────────────────────────────
    if (assistant.finish_reason === 'content_filter') {
      return { terminal: 'model_error', finalText, state }
    }

    // ── stop (and length-recovery exhausted) ────────────────────────────────
    const text = assistant.content ?? ''
    const previousMessage = state.messages[state.messages.length - 2]
    const previousWasTool = previousMessage?.role === 'tool'
    const shouldRecoverEmptyStop = previousWasTool || awaitingPostToolSummary

    if (assistant.finish_reason === 'stop' && text.trim() === '' && shouldRecoverEmptyStop) {
      if (emptyStopRecoveryCount < 1) {
        emptyStopRecoveryCount += 1
        awaitingPostToolSummary = true
        const summaryRequest: ChatMessage = {
          role: 'user',
          content:
            'You just finished tool execution. Provide a concise final summary of what changed and any next steps.',
        }
        state.messages.push(summaryRequest)
        await options.onMessageAppended?.(summaryRequest)
        continue
      }
      finalText = 'Task completed via tool execution, but the model returned no final summary.'
      return { terminal: 'completed', finalText, state }
    }
    if (text.trim() !== '') {
      awaitingPostToolSummary = false
    }

    // Nudge: model promised action but made no tool call
    if (shouldNudge(text, state)) {
      const nudgeMessage: ChatMessage = {
        role: 'user',
        content:
          'Continue with the task. Use your tools to make progress. ' +
          'If you have completed everything, describe what was done.',
      }
      state.messages.push(nudgeMessage)
      await options.onMessageAppended?.(nudgeMessage)
      state.nudgeCount += 1
      continue
    }

    finalText = text
    return { terminal: 'completed', finalText, state }
  }
}
