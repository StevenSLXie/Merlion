import type { ChatMessage, LoopState, LoopTerminal, ModelProvider, ToolCall } from '../types.js'
import type { AskUserQuestionItem, PermissionStore, ToolContext } from '../tools/types.js'
import { executeToolCalls, type ToolCallResultEvent, type ToolCallStartEvent } from './executor.ts'
import { withRetry } from './retry.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { compactMessages, estimateMessagesChars } from '../context/compact.ts'
import { createPromptObservabilityTracker, type PromptObservabilitySnapshot } from './prompt_observability.ts'
import { isBugFixPrompt } from './intent_contract.ts'
import {
  BUGFIX_NO_MUTATION_BATCH_THRESHOLD,
  formatExplorationBudgetHint,
  formatLargeDiffHint,
  formatMutationOscillationHint,
  formatNoMutationHint,
  formatNoProgressHint,
  formatOverwriteAfterEditHint,
  formatProviderErrorText,
  formatTestFirstBugFixHint,
  formatTodoDriftHint,
  formatToolArgumentHint,
  formatToolErrorHint,
  formatVerificationHint,
  inferVerificationStrength,
  isExplorationToolCall,
  isLargeMutation,
  isMutationOscillation,
  isToolArgumentValidationError,
  looksLikeCodePath,
  looksLikeTestPath,
  MAX_AUTO_TOOL_ERROR_HINTS,
  MAX_EXPLORATION_HINTS,
  MAX_LARGE_DIFF_HINTS,
  MAX_MUTATION_OSCILLATION_HINTS,
  MAX_NO_MUTATION_HINTS,
  MAX_NO_PROGRESS_HINTS,
  MAX_OVERWRITE_AFTER_EDIT_HINTS,
  MAX_TOOL_ARGUMENT_HINTS,
  MAX_TODO_DRIFT_HINTS,
  MAX_VERIFICATION_HINTS,
  mentionsVerification,
  NO_MUTATION_BATCH_THRESHOLD,
  NO_PROGRESS_BATCH_THRESHOLD,
  REPEATED_TOOL_ERROR_THRESHOLD,
  shouldNudge,
  shouldRecoverNoMutationStop,
  strongerVerificationStrength,
  TODO_ONLY_BATCH_THRESHOLD,
  toolCallSignature,
  toMutationEvent,
  type MutationEvent,
  type VerificationStrength,
  extractRelevantPaths,
} from './loop_guardrails.ts'

export { shouldNudge } from './loop_guardrails.ts'

export interface RunLoopOptions {
  provider: ModelProvider
  registry: ToolRegistry
  systemPrompt: string
  userPrompt: string
  intentContract?: string
  cwd: string
  permissions?: PermissionStore
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
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

function buildRequestMessages(
  messages: ChatMessage[],
  intentContract?: string,
): ChatMessage[] {
  const contract = intentContract?.trim()
  if (!contract) return messages
  return [
    ...messages,
    {
      role: 'system',
      content:
        'Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\n' +
        contract,
    },
  ]
}

async function tryGenerateNaturalSummary(
  options: RunLoopOptions,
  state: LoopState,
): Promise<string | null> {
  const summaryRequest: ChatMessage = {
    role: 'user',
    content:
      'Write a natural-language summary of what you completed in this run. ' +
      'Focus on concrete outcomes and mention unfinished parts only if needed. ' +
      'Do not call tools.',
  }

  state.messages.push(summaryRequest)
  await options.onMessageAppended?.(summaryRequest)

  const requestMessages = buildRequestMessages(state.messages, options.intentContract)

  try {
    const assistant = await withRetry(
      () => options.provider.complete(requestMessages, []),
      { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
    )
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistant.content,
      tool_calls: assistant.tool_calls,
    }
    state.messages.push(assistantMessage)
    await options.onMessageAppended?.(assistantMessage)
    await options.onUsage?.(assistant.usage)

    const text = (assistant.content ?? '').trim()
    return text === '' ? null : text
  } catch {
    return null
  }
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
  let autoToolErrorHintCount = 0
  let toolArgumentHintCount = 0
  let noProgressHintCount = 0
  let noMutationHintCount = 0
  let consecutiveAllErrorBatches = 0
  let consecutiveNoMutationBatches = 0
  let sawAnyToolError = false
  let sawAnySuccessfulMutation = false
  let totalToolBatches = 0
  let noMutationStopRecoveryCount = 0
  let mutationOscillationHintCount = 0
  let explorationHintCount = 0
  let verificationHintCount = 0
  let todoDriftHintCount = 0
  let consecutiveTodoOnlyBatches = 0
  let largeDiffHintCount = 0
  let overwriteAfterEditHintCount = 0
  let testFirstBugFixHintInjected = false
  let hasSuccessfulNonTestMutation = false
  let hasCodeLikeMutation = false
  let verificationStrength: VerificationStrength = 'none'
  let consecutiveExplorationBatches = 0
  const exploredPathsWindow = new Set<string>()
  const repeatedToolErrorCounts = new Map<string, number>()
  const hintedToolErrorSignatures = new Set<string>()
  const mutationHistory: MutationEvent[] = []
  const mutationOscillationSignatures = new Set<string>()
  const promptObservability = options.promptObservabilityTracker ?? createPromptObservabilityTracker()
  const bugFixMode = isBugFixPrompt(options.userPrompt)

  const defaultPermissions: PermissionStore = { ask: async () => 'allow' }
  const toolContext: ToolContext = {
    cwd: options.cwd,
    permissions: options.permissions ?? defaultPermissions,
    askQuestions: options.askQuestions,
    listTools: () =>
      options.registry.getAll().map((tool) => ({
        name: tool.name,
        description: tool.description,
        source: tool.source,
        searchHint: tool.searchHint,
        modelGuidance: tool.modelGuidance,
        modelExamples: tool.modelExamples,
        guidancePriority: tool.guidancePriority,
        requiredParameters: Array.isArray(tool.parameters.required) ? [...tool.parameters.required] : [],
        isReadOnly: tool.isReadOnly,
        isDestructive: tool.isDestructive,
        requiresUserInteraction: tool.requiresUserInteraction,
        requiresTrustedWorkspace: tool.requiresTrustedWorkspace,
      })),
  }

  if (options.persistInitialMessages !== false) {
    for (const msg of state.messages) {
      await options.onMessageAppended?.(msg)
    }
  }

  for (;;) {
    if (state.turnCount >= maxTurns) {
      if (finalText.trim() === '') {
        finalText =
          (await tryGenerateNaturalSummary(options, state)) ??
          'Reached max turns before producing a final summary.'
      }
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
      const requestMessages = buildRequestMessages(state.messages, options.intentContract)
      await options.onPromptObservability?.(
        promptObservability.record(state.turnCount + 1, requestMessages)
      )
      await options.onTurnStart?.({ turn: state.turnCount + 1 })
      assistant = await withRetry(
        () => options.provider.complete(requestMessages, options.registry.getAll()),
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
      totalToolBatches += 1

      let hint: string | null = null
      let toolArgumentHint: string | null = null
      for (const event of toolResultEvents) {
        const signature = toolCallSignature(event.call)
        if (event.isError) {
          sawAnyToolError = true
          if (
            toolArgumentHint === null &&
            toolArgumentHintCount < MAX_TOOL_ARGUMENT_HINTS &&
            isToolArgumentValidationError(event.message.content ?? '')
          ) {
            toolArgumentHint = formatToolArgumentHint(event.call)
            toolArgumentHintCount += 1
          }
          const nextCount = (repeatedToolErrorCounts.get(signature) ?? 0) + 1
          repeatedToolErrorCounts.set(signature, nextCount)
          if (
            hint === null &&
            autoToolErrorHintCount < MAX_AUTO_TOOL_ERROR_HINTS &&
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

      if (toolArgumentHint) {
        const correctionMessage: ChatMessage = { role: 'user', content: toolArgumentHint }
        state.messages.push(correctionMessage)
        await options.onMessageAppended?.(correctionMessage)
      }

      if (hint) {
        const correctionMessage: ChatMessage = { role: 'user', content: hint }
        state.messages.push(correctionMessage)
        await options.onMessageAppended?.(correctionMessage)
      }

      if (toolResultEvents.length > 0 && toolResultEvents.every((event) => event.isError)) {
        consecutiveAllErrorBatches += 1
      } else {
        consecutiveAllErrorBatches = 0
      }
      if (
        consecutiveAllErrorBatches >= NO_PROGRESS_BATCH_THRESHOLD &&
        noProgressHintCount < MAX_NO_PROGRESS_HINTS
      ) {
        const noProgressMessage: ChatMessage = {
          role: 'user',
          content: formatNoProgressHint(consecutiveAllErrorBatches)
        }
        state.messages.push(noProgressMessage)
        await options.onMessageAppended?.(noProgressMessage)
        noProgressHintCount += 1
        consecutiveAllErrorBatches = 0
      }

      let batchMutationCount = 0
      let sawTestOnlyMutationBatch = false
      let sawNonTestMutationInBatch = false
      const batchTestPaths: string[] = []
      let mutationHint: string | null = null
      let largeDiffHint: string | null = null
      let overwriteAfterEditHint: string | null = null
      let batchExplorationCount = 0
      let batchTodoWriteCount = 0
      let batchNonTodoSuccessCount = 0
      for (const event of toolResultEvents) {
        if (!event.isError) {
          verificationStrength = strongerVerificationStrength(verificationStrength, inferVerificationStrength(event.call))
          if (event.call.function.name === 'todo_write') {
            batchTodoWriteCount += 1
          } else {
            batchNonTodoSuccessCount += 1
          }
          if (isExplorationToolCall(event.call)) {
            batchExplorationCount += 1
            for (const path of extractRelevantPaths(options.cwd, event.call)) {
              exploredPathsWindow.add(path)
            }
          }
        }
        const mutation = toMutationEvent(options.cwd, event, state.turnCount)
        if (!mutation) continue
        batchMutationCount += 1
        if (looksLikeCodePath(mutation.path)) {
          hasCodeLikeMutation = true
        }
        if (looksLikeTestPath(mutation.path)) {
          batchTestPaths.push(mutation.path)
        } else {
          sawNonTestMutationInBatch = true
        }
        const previous = mutationHistory[mutationHistory.length - 1]
        if (
          mutationOscillationHintCount < MAX_MUTATION_OSCILLATION_HINTS &&
          previous &&
          isMutationOscillation(previous, mutation)
        ) {
          const oscillationKey = `${previous.signature}|${mutation.signature}`
          if (!mutationOscillationSignatures.has(oscillationKey)) {
            mutationHint = formatMutationOscillationHint(previous, mutation)
            mutationOscillationSignatures.add(oscillationKey)
            mutationOscillationHintCount += 1
          }
        }
        if (
          largeDiffHint === null &&
          largeDiffHintCount < MAX_LARGE_DIFF_HINTS &&
          isLargeMutation(mutation)
        ) {
          largeDiffHint = formatLargeDiffHint(mutation)
          largeDiffHintCount += 1
        }
        if (
          overwriteAfterEditHint === null &&
          overwriteAfterEditHintCount < MAX_OVERWRITE_AFTER_EDIT_HINTS &&
          previous &&
          previous.path === mutation.path &&
          previous.toolName === 'edit_file' &&
          mutation.toolName === 'write_file'
        ) {
          overwriteAfterEditHint = formatOverwriteAfterEditHint(previous, mutation)
          overwriteAfterEditHintCount += 1
        }
        mutationHistory.push(mutation)
        if (mutationHistory.length > 20) mutationHistory.shift()
      }
      if (mutationHint) {
        const mutationMessage: ChatMessage = { role: 'user', content: mutationHint }
        state.messages.push(mutationMessage)
        await options.onMessageAppended?.(mutationMessage)
      }
      if (largeDiffHint) {
        const reviewMessage: ChatMessage = { role: 'user', content: largeDiffHint }
        state.messages.push(reviewMessage)
        await options.onMessageAppended?.(reviewMessage)
      }
      if (overwriteAfterEditHint) {
        const overwriteMessage: ChatMessage = { role: 'user', content: overwriteAfterEditHint }
        state.messages.push(overwriteMessage)
        await options.onMessageAppended?.(overwriteMessage)
      }
      sawTestOnlyMutationBatch = batchMutationCount > 0 && batchTestPaths.length === batchMutationCount
      if (batchMutationCount > 0) {
        sawAnySuccessfulMutation = true
        consecutiveNoMutationBatches = 0
        consecutiveExplorationBatches = 0
        consecutiveTodoOnlyBatches = 0
        exploredPathsWindow.clear()
      } else if (toolResultEvents.length > 0) {
        consecutiveNoMutationBatches += 1
        if (batchExplorationCount > 0) {
          consecutiveExplorationBatches += 1
        } else {
          consecutiveExplorationBatches = 0
          exploredPathsWindow.clear()
        }
        if (batchTodoWriteCount > 0 && batchNonTodoSuccessCount === 0 && !toolResultEvents.every((event) => event.isError)) {
          consecutiveTodoOnlyBatches += 1
        } else {
          consecutiveTodoOnlyBatches = 0
        }
      }
      if (sawNonTestMutationInBatch) {
        hasSuccessfulNonTestMutation = true
      }
      if (
        bugFixMode &&
        !testFirstBugFixHintInjected &&
        !hasSuccessfulNonTestMutation &&
        sawTestOnlyMutationBatch
      ) {
        const bugFixHintMessage: ChatMessage = {
          role: 'user',
          content: formatTestFirstBugFixHint(batchTestPaths)
        }
        state.messages.push(bugFixHintMessage)
        await options.onMessageAppended?.(bugFixHintMessage)
        testFirstBugFixHintInjected = true
      }
      const noMutationThreshold = bugFixMode
        ? BUGFIX_NO_MUTATION_BATCH_THRESHOLD
        : NO_MUTATION_BATCH_THRESHOLD
      let injectedExplorationHint = false
      if (
        consecutiveExplorationBatches >= noMutationThreshold &&
        explorationHintCount < MAX_EXPLORATION_HINTS &&
        exploredPathsWindow.size >= 2
      ) {
        const explorationMessage: ChatMessage = {
          role: 'user',
          content: formatExplorationBudgetHint(consecutiveExplorationBatches, exploredPathsWindow.size, bugFixMode)
        }
        state.messages.push(explorationMessage)
        await options.onMessageAppended?.(explorationMessage)
        explorationHintCount += 1
        consecutiveExplorationBatches = 0
        exploredPathsWindow.clear()
        injectedExplorationHint = true
      }
      if (
        !injectedExplorationHint &&
        consecutiveNoMutationBatches >= noMutationThreshold &&
        noMutationHintCount < MAX_NO_MUTATION_HINTS
      ) {
        const noMutationMessage: ChatMessage = {
          role: 'user',
          content: formatNoMutationHint(consecutiveNoMutationBatches, bugFixMode)
        }
        state.messages.push(noMutationMessage)
        await options.onMessageAppended?.(noMutationMessage)
        noMutationHintCount += 1
        consecutiveNoMutationBatches = 0
      }
      if (
        consecutiveTodoOnlyBatches >= TODO_ONLY_BATCH_THRESHOLD &&
        todoDriftHintCount < MAX_TODO_DRIFT_HINTS
      ) {
        const todoDriftMessage: ChatMessage = {
          role: 'user',
          content: formatTodoDriftHint()
        }
        state.messages.push(todoDriftMessage)
        await options.onMessageAppended?.(todoDriftMessage)
        todoDriftHintCount += 1
        consecutiveTodoOnlyBatches = 0
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
    const shouldRecoverMutationlessStop =
      totalToolBatches > 0 &&
      !sawAnySuccessfulMutation &&
      sawAnyToolError &&
      shouldRecoverNoMutationStop(text)
    const shouldRecoverWeakVerificationStop =
      verificationHintCount < MAX_VERIFICATION_HINTS &&
      hasCodeLikeMutation &&
      hasSuccessfulNonTestMutation &&
      verificationStrength === 'none' &&
      text.trim() !== '' &&
      !mentionsVerification(text)

    if (assistant.finish_reason === 'stop' && text.trim() === '' && shouldRecoverEmptyStop) {
      if (emptyStopRecoveryCount < 1) {
        emptyStopRecoveryCount += 1
        awaitingPostToolSummary = true
        const summaryRequest: ChatMessage = {
          role: 'user',
          content:
            'You just finished tool execution. Please provide a natural-language final summary for this request.',
        }
        state.messages.push(summaryRequest)
        await options.onMessageAppended?.(summaryRequest)
        continue
      }
      finalText =
        (await tryGenerateNaturalSummary(options, state)) ??
        'Task completed via tool execution, but the model returned no final summary.'
      return { terminal: 'completed', finalText, state }
    }
    if (assistant.finish_reason === 'stop' && shouldRecoverMutationlessStop) {
      if (noMutationStopRecoveryCount < 1) {
        noMutationStopRecoveryCount += 1
        const recoveryMessage: ChatMessage = {
          role: 'user',
          content:
            'You have not made any successful file changes yet. Do not finish now. ' +
            'Either inspect the explicit target files/tests and apply one minimal edit, ' +
            'or explain with concrete evidence why no edit is required.'
        }
        state.messages.push(recoveryMessage)
        await options.onMessageAppended?.(recoveryMessage)
        continue
      }
    }
    if (assistant.finish_reason === 'stop' && shouldRecoverWeakVerificationStop) {
      verificationHintCount += 1
      const verificationMessage: ChatMessage = {
        role: 'user',
        content: formatVerificationHint()
      }
      state.messages.push(verificationMessage)
      await options.onMessageAppended?.(verificationMessage)
      continue
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
