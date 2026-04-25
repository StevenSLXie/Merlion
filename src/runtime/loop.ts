import { randomUUID } from 'node:crypto'

import type { LoopState, LoopTerminal, ModelProvider } from '../types.js'
import type { AskUserQuestionItem, PermissionStore, ToolContext } from '../tools/types.js'
import type { SubagentToolRuntime } from './subagent_types.ts'
import type { RuntimeSandboxEvent } from './events.ts'
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
  splitStablePrefixItems,
  itemsToMessages,
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
import type { SandboxBackend } from '../sandbox/backend.ts'
import type { ResolvedSandboxPolicy } from '../sandbox/policy.ts'
import type { TaskControlDecision } from './task_state.ts'

export { shouldNudge } from './loop_guardrails.ts'

export interface RunLoopOptions {
  provider: ModelProvider
  registry: ToolRegistry
  systemPrompt: string
  userPrompt: string
  intentContract?: string
  cwd: string
  sessionId?: string
  permissions?: PermissionStore
  sandboxPolicy?: ResolvedSandboxPolicy
  sandboxBackend?: SandboxBackend
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  subagents?: SubagentToolRuntime
  maxTurns?: number
  stablePrefixItems?: ConversationItem[]
  initialItems?: ConversationItem[]
  initialOverlayItems?: ConversationItem[]
  persistInitialMessages?: boolean
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
    record: (turn: number, items: ConversationItem[]) => PromptObservabilitySnapshot
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
  onSandboxEvent?: (event: RuntimeSandboxEvent) => Promise<void> | void
  taskControl?: TaskControlDecision
  onToolBatchComplete?: (event: {
    turn: number
    results: ToolCallResultEvent[]
  }) => Promise<ConversationItem[] | void> | ConversationItem[] | void
}

export interface RunLoopResult {
  terminal: LoopTerminal
  finalText: string
  state: LoopState
}

function buildRequestMessages(
  stablePrefixItems: ConversationItem[],
  overlayItems: ConversationItem[],
  transcriptItems: ConversationItem[],
  intentContract?: string,
): ConversationItem[] {
  const contract = intentContract?.trim()
  const requestItems = [
    ...stablePrefixItems,
    ...overlayItems,
  ]
  if (contract) {
    requestItems.push(
      createSystemItem(
        'Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\n' +
          contract,
        'runtime'
      ),
    )
  }
  return [
    ...requestItems,
    ...transcriptItems,
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

function normalizeInjectedItems(value: ConversationItem[] | void): ConversationItem[] {
  if (!Array.isArray(value) || value.length === 0) return []
  return value
}

interface InternalLoopState {
  stablePrefixItems: ConversationItem[]
  items: ConversationItem[]
  overlayItems: ConversationItem[]
  turnCount: number
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  nudgeCount: number
}

function projectLoopState(state: InternalLoopState): LoopState {
  return {
    items: [...state.stablePrefixItems, ...state.items],
    turnCount: state.turnCount,
    maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact,
    nudgeCount: state.nudgeCount,
  }
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
  state: InternalLoopState,
  options: RunLoopOptions,
  items: ConversationItem[],
  origin: TranscriptItemEntry['origin'],
  runtimeResponseId?: string,
): Promise<void> {
  if (items.length === 0) return
  for (const item of items) {
    state.items.push(item)
    await options.onItemAppended?.({
      type: 'item',
      item,
      origin,
      runtimeResponseId,
    })
  }
}

async function tryGenerateNaturalSummary(
  options: RunLoopOptions,
  state: InternalLoopState,
): Promise<string | null> {
  const summaryRequest = createRuntimeUserItem(
    'Write a natural-language summary of what you completed in this run. ' +
      'Focus on concrete outcomes and mention unfinished parts only if needed. ' +
      'Do not call tools.'
  )
  const requestItems = buildRequestMessages(
    state.stablePrefixItems,
    [...state.overlayItems, summaryRequest],
    state.items,
    options.intentContract,
  )

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
  stablePrefixItems?: ConversationItem[],
  initialItems?: ConversationItem[],
  initialOverlayItems?: ConversationItem[],
): InternalLoopState {
  const providedStablePrefix = stablePrefixItems ? [...stablePrefixItems] : undefined
  const baseState = initialItems
    ? (providedStablePrefix
        ? {
            stablePrefixItems: providedStablePrefix,
            transcriptTailItems: [...initialItems],
          }
        : splitStablePrefixItems(initialItems))
    : {
        stablePrefixItems: providedStablePrefix ?? [createSystemItem(systemPrompt, 'static')],
        transcriptTailItems: [] as ConversationItem[],
      }

  if (userPrompt.trim() !== '') {
    baseState.transcriptTailItems.push(createExternalUserItem(userPrompt))
  }

  return {
    stablePrefixItems: baseState.stablePrefixItems,
    items: baseState.transcriptTailItems,
    overlayItems: initialOverlayItems ? [...initialOverlayItems] : [],
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

interface LoopGuardrailState {
  finalText: string
  emptyStopRecoveryCount: number
  awaitingPostToolSummary: boolean
  autoToolErrorHintCount: number
  toolArgumentHintCount: number
  noProgressHintCount: number
  noMutationHintCount: number
  consecutiveAllErrorBatches: number
  consecutiveNoMutationBatches: number
  sawAnyToolError: boolean
  sawAnySuccessfulMutation: boolean
  totalToolBatches: number
  noMutationStopRecoveryCount: number
  mutationOscillationHintCount: number
  explorationHintCount: number
  verificationHintCount: number
  todoDriftHintCount: number
  consecutiveTodoOnlyBatches: number
  largeDiffHintCount: number
  overwriteAfterEditHintCount: number
  testFirstBugFixHintInjected: boolean
  hasSuccessfulNonTestMutation: boolean
  hasCodeLikeMutation: boolean
  verificationStrength: VerificationStrength
  consecutiveExplorationBatches: number
  exploredPathsWindow: Set<string>
  repeatedToolErrorCounts: Map<string, number>
  hintedToolErrorSignatures: Set<string>
  mutationHistory: MutationEvent[]
  mutationOscillationSignatures: Set<string>
  bugFixMode: boolean
}

function createLoopGuardrailState(userPrompt: string): LoopGuardrailState {
  return {
    finalText: '',
    emptyStopRecoveryCount: 0,
    awaitingPostToolSummary: false,
    autoToolErrorHintCount: 0,
    toolArgumentHintCount: 0,
    noProgressHintCount: 0,
    noMutationHintCount: 0,
    consecutiveAllErrorBatches: 0,
    consecutiveNoMutationBatches: 0,
    sawAnyToolError: false,
    sawAnySuccessfulMutation: false,
    totalToolBatches: 0,
    noMutationStopRecoveryCount: 0,
    mutationOscillationHintCount: 0,
    explorationHintCount: 0,
    verificationHintCount: 0,
    todoDriftHintCount: 0,
    consecutiveTodoOnlyBatches: 0,
    largeDiffHintCount: 0,
    overwriteAfterEditHintCount: 0,
    testFirstBugFixHintInjected: false,
    hasSuccessfulNonTestMutation: false,
    hasCodeLikeMutation: false,
    verificationStrength: 'none',
    consecutiveExplorationBatches: 0,
    exploredPathsWindow: new Set<string>(),
    repeatedToolErrorCounts: new Map<string, number>(),
    hintedToolErrorSignatures: new Set<string>(),
    mutationHistory: [],
    mutationOscillationSignatures: new Set<string>(),
    bugFixMode: isBugFixPrompt(userPrompt),
  }
}

function buildToolContext(options: RunLoopOptions): ToolContext {
  const defaultPermissions: PermissionStore = { ask: async () => 'allow' }
  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    permissions: options.permissions ?? defaultPermissions,
    sandbox: options.sandboxPolicy && options.sandboxBackend
      ? {
          policy: options.sandboxPolicy,
          backend: options.sandboxBackend,
        }
      : undefined,
    onSandboxEvent: (event) => {
      void options.onSandboxEvent?.(event)
    },
    askQuestions: options.askQuestions,
    subagents: options.subagents,
    taskControl: options.taskControl
      ? {
          kind: options.taskControl.taskState.kind,
          capabilityProfile: options.taskControl.capabilityProfile,
          mutationPolicy: options.taskControl.mutationPolicy,
        }
      : undefined,
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
}

async function persistInitialLoopState(
  state: InternalLoopState,
  options: RunLoopOptions,
): Promise<void> {
  if (options.persistInitialMessages === false) return
  for (const item of [...state.stablePrefixItems, ...state.items]) {
    await options.onItemAppended?.({
      type: 'item',
      item,
      origin: item.kind === 'function_call_output' ? 'local_tool_output' : 'local_runtime',
    })
  }
}

async function appendOverlayItems(
  state: InternalLoopState,
  items: ConversationItem[],
): Promise<void> {
  if (items.length === 0) return
  state.overlayItems.push(...items)
}

function applyReactiveCompact(state: InternalLoopState): void {
  const compactTriggerChars = parsePositiveInt(process.env.MERLION_COMPACT_TRIGGER_CHARS, 60_000)
  const keepRecent = parsePositiveInt(process.env.MERLION_COMPACT_KEEP_RECENT, 10)
  const chars = estimateItemsChars(state.items)
  if (chars <= compactTriggerChars || state.hasAttemptedReactiveCompact) return
  const compacted = compactItems(state.items, { keepRecent })
  if (!compacted.compacted) return
  state.items = compacted.items
  state.hasAttemptedReactiveCompact = true
}

async function handleToolCallPhase(params: {
  assistant: ProviderResult
  options: RunLoopOptions
  state: InternalLoopState
  guardrails: LoopGuardrailState
  toolContext: ToolContext
}): Promise<boolean> {
  const { assistant, options, state, guardrails, toolContext } = params
  if (
    assistant.finishReason !== 'tool_calls' ||
    !assistant.outputItems.some((item) => item.kind === 'function_call')
  ) {
    return false
  }

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
  guardrails.totalToolBatches += 1

  let hint: string | null = null
  let toolArgumentHint: string | null = null
  for (const event of toolResultEvents) {
    const signature = toolCallSignature(event.call)
    if (event.isError) {
      guardrails.sawAnyToolError = true
      if (
        toolArgumentHint === null &&
        guardrails.toolArgumentHintCount < MAX_TOOL_ARGUMENT_HINTS &&
        isToolArgumentValidationError(event.message.content ?? '')
      ) {
        toolArgumentHint = formatToolArgumentHint(event.call)
        guardrails.toolArgumentHintCount += 1
      }
      const nextCount = (guardrails.repeatedToolErrorCounts.get(signature) ?? 0) + 1
      guardrails.repeatedToolErrorCounts.set(signature, nextCount)
      if (
        hint === null &&
        guardrails.autoToolErrorHintCount < MAX_AUTO_TOOL_ERROR_HINTS &&
        nextCount >= REPEATED_TOOL_ERROR_THRESHOLD &&
        !guardrails.hintedToolErrorSignatures.has(signature)
      ) {
        hint = formatToolErrorHint(event.call, nextCount, options.cwd)
        guardrails.hintedToolErrorSignatures.add(signature)
        guardrails.autoToolErrorHintCount += 1
      }
      continue
    }
    guardrails.repeatedToolErrorCounts.delete(signature)
    guardrails.hintedToolErrorSignatures.delete(signature)
  }

  if (toolArgumentHint) {
    await appendOverlayItems(state, [createRuntimeUserItem(toolArgumentHint)])
  }
  if (hint) {
    await appendOverlayItems(state, [createRuntimeUserItem(hint)])
  }

  if (toolResultEvents.length > 0 && toolResultEvents.every((event) => event.isError)) {
    guardrails.consecutiveAllErrorBatches += 1
  } else {
    guardrails.consecutiveAllErrorBatches = 0
  }
  if (
    guardrails.consecutiveAllErrorBatches >= NO_PROGRESS_BATCH_THRESHOLD &&
    guardrails.noProgressHintCount < MAX_NO_PROGRESS_HINTS
  ) {
    await appendOverlayItems(state, [createRuntimeUserItem(formatNoProgressHint(guardrails.consecutiveAllErrorBatches))])
    guardrails.noProgressHintCount += 1
    guardrails.consecutiveAllErrorBatches = 0
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
      guardrails.verificationStrength = strongerVerificationStrength(
        guardrails.verificationStrength,
        inferVerificationStrength(event.call)
      )
      if (event.call.function.name === 'todo_write') {
        batchTodoWriteCount += 1
      } else {
        batchNonTodoSuccessCount += 1
      }
      if (isExplorationToolCall(event.call)) {
        batchExplorationCount += 1
        for (const path of extractRelevantPaths(options.cwd, event.call)) {
          guardrails.exploredPathsWindow.add(path)
        }
      }
    }
    const mutation = toMutationEvent(options.cwd, event, state.turnCount)
    if (!mutation) continue
    batchMutationCount += 1
    if (looksLikeCodePath(mutation.path)) {
      guardrails.hasCodeLikeMutation = true
    }
    if (looksLikeTestPath(mutation.path)) {
      batchTestPaths.push(mutation.path)
    } else {
      sawNonTestMutationInBatch = true
    }
    const previous = guardrails.mutationHistory[guardrails.mutationHistory.length - 1]
    if (
      guardrails.mutationOscillationHintCount < MAX_MUTATION_OSCILLATION_HINTS &&
      previous &&
      isMutationOscillation(previous, mutation)
    ) {
      const oscillationKey = `${previous.signature}|${mutation.signature}`
      if (!guardrails.mutationOscillationSignatures.has(oscillationKey)) {
        mutationHint = formatMutationOscillationHint(previous, mutation)
        guardrails.mutationOscillationSignatures.add(oscillationKey)
        guardrails.mutationOscillationHintCount += 1
      }
    }
    if (
      largeDiffHint === null &&
      guardrails.largeDiffHintCount < MAX_LARGE_DIFF_HINTS &&
      isLargeMutation(mutation)
    ) {
      largeDiffHint = formatLargeDiffHint(mutation)
      guardrails.largeDiffHintCount += 1
    }
    if (
      overwriteAfterEditHint === null &&
      guardrails.overwriteAfterEditHintCount < MAX_OVERWRITE_AFTER_EDIT_HINTS &&
      previous &&
      previous.path === mutation.path &&
      previous.toolName === 'edit_file' &&
      mutation.toolName === 'write_file'
    ) {
      overwriteAfterEditHint = formatOverwriteAfterEditHint(previous, mutation)
      guardrails.overwriteAfterEditHintCount += 1
    }
    guardrails.mutationHistory.push(mutation)
    if (guardrails.mutationHistory.length > 20) guardrails.mutationHistory.shift()
  }

  if (mutationHint) {
    await appendOverlayItems(state, [createRuntimeUserItem(mutationHint)])
  }
  if (largeDiffHint) {
    await appendOverlayItems(state, [createRuntimeUserItem(largeDiffHint)])
  }
  if (overwriteAfterEditHint) {
    await appendOverlayItems(state, [createRuntimeUserItem(overwriteAfterEditHint)])
  }

  sawTestOnlyMutationBatch = batchMutationCount > 0 && batchTestPaths.length === batchMutationCount
  if (batchMutationCount > 0) {
    guardrails.sawAnySuccessfulMutation = true
    guardrails.consecutiveNoMutationBatches = 0
    guardrails.consecutiveExplorationBatches = 0
    guardrails.consecutiveTodoOnlyBatches = 0
    guardrails.exploredPathsWindow.clear()
  } else if (toolResultEvents.length > 0) {
    guardrails.consecutiveNoMutationBatches += 1
    if (batchExplorationCount > 0) {
      guardrails.consecutiveExplorationBatches += 1
    } else {
      guardrails.consecutiveExplorationBatches = 0
      guardrails.exploredPathsWindow.clear()
    }
    if (batchTodoWriteCount > 0 && batchNonTodoSuccessCount === 0 && !toolResultEvents.every((event) => event.isError)) {
      guardrails.consecutiveTodoOnlyBatches += 1
    } else {
      guardrails.consecutiveTodoOnlyBatches = 0
    }
  }

  if (sawNonTestMutationInBatch) {
    guardrails.hasSuccessfulNonTestMutation = true
  }
  if (
    guardrails.bugFixMode &&
    !guardrails.testFirstBugFixHintInjected &&
    !guardrails.hasSuccessfulNonTestMutation &&
    sawTestOnlyMutationBatch
  ) {
    await appendOverlayItems(state, [createRuntimeUserItem(formatTestFirstBugFixHint(batchTestPaths))])
    guardrails.testFirstBugFixHintInjected = true
  }

  const noMutationThreshold = guardrails.bugFixMode
    ? BUGFIX_NO_MUTATION_BATCH_THRESHOLD
    : NO_MUTATION_BATCH_THRESHOLD
  let injectedExplorationHint = false
  if (
    guardrails.consecutiveExplorationBatches >= noMutationThreshold &&
    guardrails.explorationHintCount < MAX_EXPLORATION_HINTS &&
    guardrails.exploredPathsWindow.size >= 2
  ) {
    await appendOverlayItems(
      state,
      [createRuntimeUserItem(
        formatExplorationBudgetHint(
          guardrails.consecutiveExplorationBatches,
          guardrails.exploredPathsWindow.size,
          guardrails.bugFixMode
        )
      )],
    )
    guardrails.explorationHintCount += 1
    guardrails.consecutiveExplorationBatches = 0
    guardrails.exploredPathsWindow.clear()
    injectedExplorationHint = true
  }
  if (
    !injectedExplorationHint &&
    guardrails.consecutiveNoMutationBatches >= noMutationThreshold &&
    guardrails.noMutationHintCount < MAX_NO_MUTATION_HINTS
  ) {
    await appendOverlayItems(
      state,
      [createRuntimeUserItem(formatNoMutationHint(guardrails.consecutiveNoMutationBatches, guardrails.bugFixMode))],
    )
    guardrails.noMutationHintCount += 1
    guardrails.consecutiveNoMutationBatches = 0
  }
  if (
    guardrails.consecutiveTodoOnlyBatches >= TODO_ONLY_BATCH_THRESHOLD &&
    guardrails.todoDriftHintCount < MAX_TODO_DRIFT_HINTS
  ) {
    await appendOverlayItems(state, [createRuntimeUserItem(formatTodoDriftHint())])
    guardrails.todoDriftHintCount += 1
    guardrails.consecutiveTodoOnlyBatches = 0
  }

  const postToolMessages = await options.onToolBatchComplete?.({
    turn: state.turnCount,
    results: toolResultEvents,
  })
  if (Array.isArray(postToolMessages) && postToolMessages.length > 0) {
    await appendOverlayItems(state, normalizeInjectedItems(postToolMessages))
  }
  return true
}

async function handleTerminalPhase(params: {
  assistant: ProviderResult
  options: RunLoopOptions
  state: InternalLoopState
  guardrails: LoopGuardrailState
  lastSignificantItemBeforeAssistant: ConversationItem | undefined
}): Promise<'continue' | RunLoopResult> {
  const { assistant, options, state, guardrails, lastSignificantItemBeforeAssistant } = params

  if (assistant.finishReason === 'length' && state.maxOutputTokensRecoveryCount < 3) {
    state.maxOutputTokensRecoveryCount += 1
    await appendOverlayItems(
      state,
      [createRuntimeUserItem('Output was cut off. Continue directly from where you stopped. No recap, no apology.')],
    )
    return 'continue'
  }

  if (assistant.finishReason === 'content_filter') {
    return { terminal: 'model_error', finalText: guardrails.finalText, state: projectLoopState(state) }
  }

  const text = findLastAssistantText(assistant.outputItems)
  const previousWasTool = lastSignificantItemBeforeAssistant?.kind === 'function_call_output'
  const shouldRecoverEmptyStop = previousWasTool || guardrails.awaitingPostToolSummary
  const shouldRecoverMutationlessStop =
    guardrails.totalToolBatches > 0 &&
    !guardrails.sawAnySuccessfulMutation &&
    guardrails.sawAnyToolError &&
    shouldRecoverNoMutationStop(text)
  const shouldRecoverWeakVerificationStop =
    guardrails.verificationHintCount < MAX_VERIFICATION_HINTS &&
    guardrails.hasCodeLikeMutation &&
    guardrails.hasSuccessfulNonTestMutation &&
    guardrails.verificationStrength === 'none' &&
    text.trim() !== '' &&
    !mentionsVerification(text)

  if (assistant.finishReason === 'stop' && text.trim() === '' && shouldRecoverEmptyStop) {
    if (guardrails.emptyStopRecoveryCount < 1) {
      guardrails.emptyStopRecoveryCount += 1
      guardrails.awaitingPostToolSummary = true
      await appendOverlayItems(
        state,
        [createRuntimeUserItem('You just finished tool execution. Please provide a natural-language final summary for this request.')],
      )
      return 'continue'
    }
    guardrails.finalText =
      (await tryGenerateNaturalSummary(options, state)) ??
      'Task completed via tool execution, but the model returned no final summary.'
    return { terminal: 'completed', finalText: guardrails.finalText, state: projectLoopState(state) }
  }

  if (assistant.finishReason === 'stop' && shouldRecoverMutationlessStop) {
    if (guardrails.noMutationStopRecoveryCount < 1) {
      guardrails.noMutationStopRecoveryCount += 1
      await appendOverlayItems(
        state,
        [
          createRuntimeUserItem(
            'You have not made any successful file changes yet. Do not finish now. ' +
              'Either inspect the explicit target files/tests and apply one minimal edit, ' +
              'or explain with concrete evidence why no edit is required.'
          )
        ],
      )
      return 'continue'
    }
  }

  if (assistant.finishReason === 'stop' && shouldRecoverWeakVerificationStop) {
    guardrails.verificationHintCount += 1
    await appendOverlayItems(state, [createRuntimeUserItem(formatVerificationHint())])
    return 'continue'
  }

  if (text.trim() !== '') {
    guardrails.awaitingPostToolSummary = false
  }

  if (shouldNudge(text, state)) {
    await appendOverlayItems(
      state,
      [createRuntimeUserItem(
        'Continue with the task. Use your tools to make progress. ' +
          'If you have completed everything, describe what was done.'
      )],
    )
    state.nudgeCount += 1
    return 'continue'
  }

  guardrails.finalText = text
  return { terminal: 'completed', finalText: guardrails.finalText, state: projectLoopState(state) }
}

export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const state = createState(
    options.systemPrompt,
    options.userPrompt,
    options.stablePrefixItems,
    options.initialItems,
    options.initialOverlayItems,
  )
  const maxTurns = options.maxTurns ?? 100
  const guardrails = createLoopGuardrailState(options.userPrompt)
  const promptObservability = options.promptObservabilityTracker ?? createPromptObservabilityTracker()
  const toolContext = buildToolContext(options)

  await persistInitialLoopState(state, options)

  for (;;) {
    if (state.turnCount >= maxTurns) {
      if (guardrails.finalText.trim() === '') {
        guardrails.finalText =
          (await tryGenerateNaturalSummary(options, state)) ??
          'Reached max turns before producing a final summary.'
      }
      return { terminal: 'max_turns_exceeded', finalText: guardrails.finalText, state: projectLoopState(state) }
    }

    let assistant: ProviderResult
    let promptSnapshot: PromptObservabilitySnapshot | undefined
    try {
      applyReactiveCompact(state)
      const requestItems = buildRequestMessages(
        state.stablePrefixItems,
        state.overlayItems,
        state.items,
        options.intentContract,
      )
      promptSnapshot = promptObservability.record(state.turnCount + 1, requestItems)
      await options.onPromptObservability?.(promptSnapshot)
      await options.onTurnStart?.({ turn: state.turnCount + 1 })
      assistant = await withRetry(
        () => completeProviderTurn(options, requestItems),
        { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 32_000 },
      )
    } catch (error) {
      return { terminal: 'model_error', finalText: formatProviderErrorText(error), state: projectLoopState(state) }
    }

    state.turnCount += 1

    const lastSignificantItemBeforeAssistant = findLastSignificantItem(state.items)
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
      content: findLastAssistantText(assistant.outputItems) || null,
    })

    if (await handleToolCallPhase({ assistant, options, state, guardrails, toolContext })) {
      continue
    }

    const terminal = await handleTerminalPhase({
      assistant,
      options,
      state,
      guardrails,
      lastSignificantItemBeforeAssistant,
    })
    if (terminal === 'continue') continue
    return terminal
  }
}
