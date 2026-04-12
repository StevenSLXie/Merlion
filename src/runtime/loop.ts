import type { ChatMessage, LoopState, LoopTerminal, ModelProvider, ToolCall } from '../types.js'
import type { PermissionStore, ToolContext } from '../tools/types.js'
import { executeToolCalls, type ToolCallResultEvent, type ToolCallStartEvent } from './executor.ts'
import { withRetry } from './retry.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { compactMessages, estimateMessagesChars } from '../context/compact.ts'
import { createPromptObservabilityTracker, type PromptObservabilitySnapshot } from './prompt_observability.ts'

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
  onPromptObservability?: (snapshot: PromptObservabilitySnapshot) => Promise<void> | void
  promptObservabilityTracker?: {
    record: (turn: number, messages: ChatMessage[]) => PromptObservabilitySnapshot
  }
  onTurnStart?: (event: { turn: number }) => Promise<void> | void
  onAssistantResponse?: (event: {
    turn: number
    finish_reason: string
    tool_calls_count: number
    content: string | null
  }) => Promise<void> | void
  onToolCallStart?: (event: ToolCallStartEvent) => Promise<void> | void
  onToolCallResult?: (event: ToolCallResultEvent) => Promise<void> | void
  onToolBatchComplete?: (event: {
    turn: number
    results: ToolCallResultEvent[]
  }) => Promise<ChatMessage[] | void> | ChatMessage[] | void
}

export interface RunLoopResult {
  terminal: LoopTerminal
  finalText: string
  state: LoopState
}

// Patterns that signal the model promised action but made no tool calls.
// Includes English + Chinese phrasing to reduce false-start stalls.
const WILL_DO_PATTERNS: RegExp[] = [
  /\bi('ll| will)\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
  /\blet me\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
  /\bi('m| am) going to\s+\w/i,
  /\bfirst,?\s+i('ll| will)\s+\w/i,
  /\bto (start|begin|proceed),?\s+i('ll| will)\s+\w/i,
  /(我来|让我|我会|我将|我先|首先).{0,8}(查看|检查|读取|搜索|查找|分析|修复|修改|创建|运行|执行|看看|浏览)/,
  /(先|首先).{0,8}(查看|检查|读取|搜索|查找|分析|修复|修改|创建|运行|执行)/,
]

const REPEATED_TOOL_ERROR_THRESHOLD = 3
const MAX_AUTO_TOOL_ERROR_HINTS = 3
const COMPLETION_HINT_PATTERNS: RegExp[] = [
  /\b(done|finished|completed)\b/i,
  /已(完成|处理|修复|解决)/,
  /已经(完成|处理|修复|解决)/,
]

function looksLikeAuthError(message: string): boolean {
  const normalized = message.toLowerCase()
  if (/\b(401|403)\b/.test(normalized)) return true
  return (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid api key') ||
    normalized.includes('incorrect api key') ||
    normalized.includes('authentication')
  )
}

function formatProviderErrorText(error: unknown): string {
  const raw = String(error ?? '').trim()
  if (looksLikeAuthError(raw)) {
    return [
      'Provider authentication failed (401/403).',
      'Your API key may be invalid, expired, or revoked.',
      '',
      'How to fix:',
      '1. Run `merlion config` to reopen the setup wizard.',
      '2. Or update key/model/provider in `~/.config/merlion/config.json`.',
      '3. Or export env vars and retry: `MERLION_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`.',
      '',
      `Raw error: ${raw || '(empty error message)'}`
    ].join('\n')
  }
  if (raw !== '') return raw
  return 'Model provider request failed.'
}

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

  const trimmed = text.trim()

  // Very short text is conversational/ack-like — never nudge.
  if (trimmed.length < 8) return false

  // Don't nudge explicit completion statements.
  if (COMPLETION_HINT_PATTERNS.some((p) => p.test(trimmed))) return false

  // Core signal: contains a "will do X" promise without having done X
  return WILL_DO_PATTERNS.some((p) => p.test(trimmed))
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function toolCallSignature(call: ToolCall): string {
  const raw = call.function.arguments
  try {
    const parsed = JSON.parse(raw) as unknown
    return `${call.function.name}:${stableStringify(parsed)}`
  } catch {
    return `${call.function.name}:${raw.trim()}`
  }
}

function formatToolErrorHint(
  call: ToolCall,
  count: number,
  cwd: string,
): string {
  return (
    `Repeated tool failure detected: \`${call.function.name}\` with the same arguments failed ${count} times. ` +
    `Do not repeat the same call again. Re-check paths from workspace root (${cwd}). ` +
    'Use `list_dir` on `.` first, then call tools with real project paths. ' +
    `If you need Merlion artifacts, only use project-local paths under \`${cwd}/.merlion\`. ` +
    'Do not use `~/.merlion` and do not construct `.merlion/<project>/...` paths.'
  )
}

export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const state = createState(options.systemPrompt, options.userPrompt, options.initialMessages)
  const maxTurns = options.maxTurns ?? 100
  let finalText = ''
  let emptyStopRecoveryCount = 0
  let awaitingPostToolSummary = false
  let autoToolErrorHintCount = 0
  const repeatedToolErrorCounts = new Map<string, number>()
  const hintedToolErrorSignatures = new Set<string>()
  const promptObservability = options.promptObservabilityTracker ?? createPromptObservabilityTracker()

  const defaultPermissions: PermissionStore = { ask: async () => 'allow' }
  const toolContext: ToolContext = {
    cwd: options.cwd,
    permissions: options.permissions ?? defaultPermissions,
    listTools: () =>
      options.registry.getAll().map((tool) => ({
        name: tool.name,
        description: tool.description
      })),
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
      await options.onPromptObservability?.(
        promptObservability.record(state.turnCount + 1, state.messages)
      )
      await options.onTurnStart?.({ turn: state.turnCount + 1 })
      assistant = await withRetry(
        () => options.provider.complete(state.messages, options.registry.getAll()),
        { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 32_000 },
      )
    } catch (error) {
      return { terminal: 'model_error', finalText: formatProviderErrorText(error), state }
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
      const toolResultEvents: ToolCallResultEvent[] = []
      const maxConcurrency = Number(process.env.MERLION_MAX_TOOL_CONCURRENCY ?? '10')
      const toolMessages = await executeToolCalls({
        toolCalls: assistant.tool_calls,
        registry: options.registry,
        toolContext,
        maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 10,
        onToolCallStart: options.onToolCallStart,
        onToolCallResult: async (event) => {
          toolResultEvents.push(event)
          await options.onToolCallResult?.(event)
        },
      })

      for (const toolMsg of toolMessages) {
        state.messages.push(toolMsg)
        await options.onMessageAppended?.(toolMsg)
      }

      if (autoToolErrorHintCount < MAX_AUTO_TOOL_ERROR_HINTS) {
        let hint: string | null = null
        for (const event of toolResultEvents) {
          const signature = toolCallSignature(event.call)
          if (event.isError) {
            const nextCount = (repeatedToolErrorCounts.get(signature) ?? 0) + 1
            repeatedToolErrorCounts.set(signature, nextCount)
            if (
              hint === null &&
              nextCount >= REPEATED_TOOL_ERROR_THRESHOLD &&
              !hintedToolErrorSignatures.has(signature)
            ) {
              hint = formatToolErrorHint(event.call, nextCount, options.cwd)
              hintedToolErrorSignatures.add(signature)
              autoToolErrorHintCount += 1
            }
            continue
          }
          repeatedToolErrorCounts.delete(signature)
          hintedToolErrorSignatures.delete(signature)
        }

        if (hint) {
          const correctionMessage: ChatMessage = { role: 'user', content: hint }
          state.messages.push(correctionMessage)
          await options.onMessageAppended?.(correctionMessage)
        }
      }

      const postToolMessages = await options.onToolBatchComplete?.({
        turn: state.turnCount,
        results: toolResultEvents
      })
      if (Array.isArray(postToolMessages)) {
        for (const postToolMessage of postToolMessages) {
          state.messages.push(postToolMessage)
          await options.onMessageAppended?.(postToolMessage)
        }
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
