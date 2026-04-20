import { randomUUID } from 'node:crypto'

import type { ChatMessage, LoopState, LoopTerminal, ModelProvider, ToolCall } from '../types.js'
import type { AskUserQuestionItem, PermissionStore, ToolContext } from '../tools/types.js'
import { executeToolCalls, type ToolCallResultEvent, type ToolCallStartEvent } from './executor.ts'
import { withRetry } from './retry.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { compactItems, estimateItemsChars } from '../context/compact.ts'
import {
  createPromptObservabilityTracker,
  type PromptObservabilitySnapshot,
  withResponseBoundaryPromptObservability,
} from './prompt_observability.ts'
import {
  assistantResponseToItems,
  countFunctionCallItems,
  createExternalUserItem,
  createRuntimeUserItem,
  createSystemItem,
  findLastAssistantText,
  functionCallItemsToToolCalls,
  itemsToMessages,
  messagesToItems,
  toolResultMessageToOutputItem,
  type ConversationItem,
  type ProviderResponseBoundary,
  type ProviderResult,
  type TranscriptItemEntry,
} from './items.ts'
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
  initialItems?: ConversationItem[]
  persistInitialMessages?: boolean
  onMessageAppended?: (message: ChatMessage) => Promise<void> | void
  onItemAppended?: (entry: TranscriptItemEntry) => Promise<void> | void
  onResponseBoundary?: (boundary: ProviderResponseBoundary) => Promise<void> | void
  onUsage?: (usage: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
    provider?: string
    runtimeResponseId?: string
    providerResponseId?: string
    providerFinishReason?: string
  }) => Promise<void> | void
  onPromptObservability?: (snapshot: PromptObservabilitySnapshot) => Promise<void> | void
  promptObservabilityTracker?: {
    record: (turn: number, items: ConversationItem[] | ChatMessage[]) => PromptObservabilitySnapshot
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
  }) => Promise<ConversationItem[] | ChatMessage[] | void> | ConversationItem[] | ChatMessage[] | void
}

export interface RunLoopResult {
  terminal: LoopTerminal
  finalText: string
  state: LoopState
}

function buildRequestMessages(
  items: ConversationItem[],
  intentContract?: string,
): ConversationItem[] {
  const contract = intentContract?.trim()
  if (!contract) return items
  return [
    ...items,
    createSystemItem(
      'Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\n' +
        contract,
      'runtime'
    ),
  ]
}

function ensureBoundary(
  boundary: ProviderResponseBoundary | undefined,
  result: ProviderResult,
  provider: ModelProvider,
): ProviderResponseBoundary {
  if (boundary) return boundary
  return {
    runtimeResponseId: randomUUID(),
    providerResponseId: result.providerResponseId,
    provider: result.usage.provider ?? provider.constructor.name,
    finishReason: result.finishReason,
    outputItemCount: result.outputItems.length,
    createdAt: new Date().toISOString(),
  }
}

function normalizeInjectedItems(
  value: ConversationItem[] | ChatMessage[] | void
): ConversationItem[] {
  if (!Array.isArray(value) || value.length === 0) return []
  const first = value[0] as ConversationItem | ChatMessage
  if (first && typeof first === 'object' && 'kind' in first) {
    return value as ConversationItem[]
  }
  return messagesToItems(value as ChatMessage[])
}

function ensureStateItems(state: LoopState): ConversationItem[] {
  if (!state.items) {
    state.items = messagesToItems(state.messages)
  }
  return state.items
}

function findLastSignificantItem(items: ConversationItem[]): ConversationItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item) continue
    if (
      item.kind === 'message' &&
      ((item.role === 'user' && item.source === 'runtime') || (item.role === 'system' && item.source === 'runtime'))
    ) {
      continue
    }
    return item
  }
  return undefined
}

async function completeProviderTurn(
  options: RunLoopOptions,
  items: ConversationItem[],
): Promise<ProviderResult> {
  if (typeof options.provider.completeItems === 'function') {
    return await options.provider.completeItems(items, options.registry.getAll())
  }
  const messages = itemsToMessages(items)
  const assistant = await options.provider.complete(messages, options.registry.getAll())
  return {
    outputItems: assistantResponseToItems(assistant),
    finishReason: assistant.finish_reason,
    usage: assistant.usage,
    responseBoundary: {
      runtimeResponseId: randomUUID(),
      provider: assistant.usage.provider ?? options.provider.constructor.name,
      finishReason: assistant.finish_reason,
      outputItemCount: assistantResponseToItems(assistant).length,
      createdAt: new Date().toISOString(),
    }
  }
}

async function appendItems(
  state: LoopState,
  options: RunLoopOptions,
  items: ConversationItem[],
  origin: TranscriptItemEntry['origin'],
  runtimeResponseId?: string,
): Promise<void> {
  if (items.length === 0) return
  const stateItems = ensureStateItems(state)
  for (const item of items) {
    stateItems.push(item)
    await options.onItemAppended?.({
      type: 'item',
      item,
      origin,
      runtimeResponseId,
    })
  }
  const rendered = itemsToMessages(items)
  if (rendered.length > 0) {
    for (const message of rendered) {
      await options.onMessageAppended?.(message)
    }
  }
  state.messages = itemsToMessages(stateItems)
}

async function tryGenerateNaturalSummary(
  options: RunLoopOptions,
  state: LoopState,
): Promise<string | null> {
  const summaryRequest = createRuntimeUserItem(
    'Write a natural-language summary of what you completed in this run. ' +
      'Focus on concrete outcomes and mention unfinished parts only if needed. ' +
      'Do not call tools.'
  )

  await appendItems(state, options, [summaryRequest], 'local_runtime')

  const requestItems = buildRequestMessages(ensureStateItems(state), options.intentContract)

  try {
    const result = await withRetry(
      () => completeProviderTurn({ ...options, registry: new ToolRegistry() }, requestItems),
      { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
    )

    const boundary = ensureBoundary(result.responseBoundary, result, options.provider)
    await options.onResponseBoundary?.(boundary)
    await appendItems(state, options, result.outputItems, 'provider_output', boundary.runtimeResponseId)
    await options.onUsage?.({
      ...result.usage,
      runtimeResponseId: boundary.runtimeResponseId,
      providerResponseId: boundary.providerResponseId,
      providerFinishReason: boundary.finishReason,
    })

    const text = findLastAssistantText(result.outputItems).trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

function createState(
  systemPrompt: string,
  userPrompt: string,
  initialMessages?: ChatMessage[],
  initialItems?: ConversationItem[],
): LoopState {
  const items: ConversationItem[] = initialItems
    ? [...initialItems]
    : initialMessages
      ? messagesToItems(initialMessages)
      : [
          createSystemItem(systemPrompt, 'static'),
          ...(userPrompt.trim() !== '' ? [createExternalUserItem(userPrompt)] : []),
        ]

  if ((initialItems || initialMessages) && userPrompt.trim() !== '') {
    items.push(createExternalUserItem(userPrompt))
  }

  return {
    items,
    messages: itemsToMessages(items),
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
  const state = createState(options.systemPrompt, options.userPrompt, options.initialMessages, options.initialItems)
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
    for (const item of ensureStateItems(state)) {
      await options.onItemAppended?.({
        type: 'item',
        item,
        origin: item.kind === 'function_call_output' ? 'local_tool_output' : 'local_runtime',
      })
    }
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
    let promptSnapshot: PromptObservabilitySnapshot | undefined
    try {
      const compactTriggerChars = parsePositiveInt(process.env.MERLION_COMPACT_TRIGGER_CHARS, 60_000)
      const keepRecent = parsePositiveInt(process.env.MERLION_COMPACT_KEEP_RECENT, 10)
      const chars = estimateItemsChars(ensureStateItems(state))
      if (chars > compactTriggerChars && !state.hasAttemptedReactiveCompact) {
        const compacted = compactItems(ensureStateItems(state), { keepRecent })
        if (compacted.compacted) {
          state.items = compacted.items
          state.messages = itemsToMessages(compacted.items)
          state.hasAttemptedReactiveCompact = true
        }
      }
      const requestItems = buildRequestMessages(ensureStateItems(state), options.intentContract)
      promptSnapshot = promptObservability.record(state.turnCount + 1, requestItems)
      await options.onPromptObservability?.(promptSnapshot)
      await options.onTurnStart?.({ turn: state.turnCount + 1 })
      assistant = await withRetry(
        () => completeProviderTurn(options, requestItems),
        { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 32_000 },
      )
    } catch (error) {
      return { terminal: 'model_error', finalText: formatProviderErrorText(error), state }
    }

    state.turnCount += 1

    const lastSignificantItemBeforeAssistant = findLastSignificantItem(ensureStateItems(state))
    const boundary = ensureBoundary(assistant.responseBoundary, assistant, options.provider)
    await options.onResponseBoundary?.(boundary)
    if (promptSnapshot) {
      promptSnapshot = withResponseBoundaryPromptObservability(promptSnapshot, boundary)
      await options.onPromptObservability?.(promptSnapshot)
    }
    await appendItems(state, options, assistant.outputItems, 'provider_output', boundary.runtimeResponseId)
    await options.onUsage?.({
      ...assistant.usage,
      runtimeResponseId: boundary.runtimeResponseId,
      providerResponseId: boundary.providerResponseId,
      providerFinishReason: boundary.finishReason,
    })
    await options.onAssistantResponse?.({
      turn: state.turnCount,
      finish_reason: assistant.finishReason,
      tool_calls_count: countFunctionCallItems(assistant.outputItems),
      content: findLastAssistantText(assistant.outputItems) || null
    })

    // ── tool_calls ──────────────────────────────────────────────────────────
    if (
      assistant.finishReason === 'tool_calls' &&
      assistant.outputItems.some((item) => item.kind === 'function_call')
    ) {
      const toolResultEvents: ToolCallResultEvent[] = []
      const maxConcurrency = Number(process.env.MERLION_MAX_TOOL_CONCURRENCY ?? '10')
      const functionCalls = assistant.outputItems.filter((item) => item.kind === 'function_call')
      const toolMessages = await executeToolCalls({
        toolCalls: functionCallItemsToToolCalls(functionCalls),
        registry: options.registry,
        toolContext,
        maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 10,
        onToolCallStart: options.onToolCallStart,
        onToolCallResult: async (event) => {
          toolResultEvents.push(event)
          await options.onToolCallResult?.(event)
        },
      })

      const toolOutputItems = toolMessages.map((message) => toolResultMessageToOutputItem(message)).filter(Boolean) as ConversationItem[]
      await appendItems(state, options, toolOutputItems, 'local_tool_output')
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
        await appendItems(state, options, [createRuntimeUserItem(toolArgumentHint)], 'local_runtime')
      }

      if (hint) {
        await appendItems(state, options, [createRuntimeUserItem(hint)], 'local_runtime')
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
        await appendItems(state, options, [createRuntimeUserItem(formatNoProgressHint(consecutiveAllErrorBatches))], 'local_runtime')
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
        await appendItems(state, options, [createRuntimeUserItem(mutationHint)], 'local_runtime')
      }
      if (largeDiffHint) {
        await appendItems(state, options, [createRuntimeUserItem(largeDiffHint)], 'local_runtime')
      }
      if (overwriteAfterEditHint) {
        await appendItems(state, options, [createRuntimeUserItem(overwriteAfterEditHint)], 'local_runtime')
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
        await appendItems(state, options, [createRuntimeUserItem(formatTestFirstBugFixHint(batchTestPaths))], 'local_runtime')
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
        await appendItems(
          state,
          options,
          [createRuntimeUserItem(formatExplorationBudgetHint(consecutiveExplorationBatches, exploredPathsWindow.size, bugFixMode))],
          'local_runtime'
        )
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
        await appendItems(
          state,
          options,
          [createRuntimeUserItem(formatNoMutationHint(consecutiveNoMutationBatches, bugFixMode))],
          'local_runtime'
        )
        noMutationHintCount += 1
        consecutiveNoMutationBatches = 0
      }
      if (
        consecutiveTodoOnlyBatches >= TODO_ONLY_BATCH_THRESHOLD &&
        todoDriftHintCount < MAX_TODO_DRIFT_HINTS
      ) {
        await appendItems(state, options, [createRuntimeUserItem(formatTodoDriftHint())], 'local_runtime')
        todoDriftHintCount += 1
        consecutiveTodoOnlyBatches = 0
      }

      const postToolMessages = await options.onToolBatchComplete?.({
        turn: state.turnCount,
        results: toolResultEvents
      })
      if (Array.isArray(postToolMessages) && postToolMessages.length > 0) {
        await appendItems(state, options, normalizeInjectedItems(postToolMessages), 'local_runtime')
      }
      continue
    }

    // ── length (output truncated) ────────────────────────────────────────────
    if (assistant.finishReason === 'length' && state.maxOutputTokensRecoveryCount < 3) {
      state.maxOutputTokensRecoveryCount += 1
      await appendItems(
        state,
        options,
        [createRuntimeUserItem('Output was cut off. Continue directly from where you stopped. No recap, no apology.')],
        'local_runtime'
      )
      continue
    }

    // ── content_filter ───────────────────────────────────────────────────────
    if (assistant.finishReason === 'content_filter') {
      return { terminal: 'model_error', finalText, state }
    }

    // ── stop (and length-recovery exhausted) ────────────────────────────────
    const text = findLastAssistantText(assistant.outputItems)
    const previousWasTool = lastSignificantItemBeforeAssistant?.kind === 'function_call_output'
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

    if (assistant.finishReason === 'stop' && text.trim() === '' && shouldRecoverEmptyStop) {
      if (emptyStopRecoveryCount < 1) {
        emptyStopRecoveryCount += 1
        awaitingPostToolSummary = true
        await appendItems(
          state,
          options,
          [createRuntimeUserItem('You just finished tool execution. Please provide a natural-language final summary for this request.')],
          'local_runtime'
        )
        continue
      }
      finalText =
        (await tryGenerateNaturalSummary(options, state)) ??
        'Task completed via tool execution, but the model returned no final summary.'
      return { terminal: 'completed', finalText, state }
    }
    if (assistant.finishReason === 'stop' && shouldRecoverMutationlessStop) {
      if (noMutationStopRecoveryCount < 1) {
        noMutationStopRecoveryCount += 1
        await appendItems(
          state,
          options,
          [
            createRuntimeUserItem(
              'You have not made any successful file changes yet. Do not finish now. ' +
                'Either inspect the explicit target files/tests and apply one minimal edit, ' +
                'or explain with concrete evidence why no edit is required.'
            )
          ],
          'local_runtime'
        )
        continue
      }
    }
    if (assistant.finishReason === 'stop' && shouldRecoverWeakVerificationStop) {
      verificationHintCount += 1
      await appendItems(state, options, [createRuntimeUserItem(formatVerificationHint())], 'local_runtime')
      continue
    }
    if (text.trim() !== '') {
      awaitingPostToolSummary = false
    }

    // Nudge: model promised action but made no tool call
    if (shouldNudge(text, state)) {
      await appendItems(
        state,
        options,
        [createRuntimeUserItem(
          'Continue with the task. Use your tools to make progress. ' +
            'If you have completed everything, describe what was done.'
        )],
        'local_runtime'
      )
      state.nudgeCount += 1
      continue
    }

    finalText = text
    return { terminal: 'completed', finalText, state }
  }
}
