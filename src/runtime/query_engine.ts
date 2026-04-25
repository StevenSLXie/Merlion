import type { ModelProvider } from '../types.js'
import type { ConversationItem, PersistedConversationProjection, ProviderResponseBoundary } from './items.ts'
import { createSystemItem, projectPersistentConversationItems } from './items.ts'
import type { AskUserQuestionItem, PermissionStore } from '../tools/types.js'
import type { SubagentToolRuntime } from './subagent_types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { runLoop, type RunLoopResult } from './loop.ts'
import type { PromptObservabilitySnapshot } from './prompt_observability.ts'
import type { RuntimeSink } from './events.ts'
import { detectSuccessfulGitCommit, summarizeToolBatchMilestones } from './tool_batch_milestones.ts'
import type { UsageRates, UsageSnapshot } from './usage.ts'
import { calculateUsageCostUsd } from './usage.ts'
import { updateCodebaseIndexWithChangedFiles } from '../artifacts/codebase_index.ts'
import { updateProgressFromRuntimeSignals } from '../artifacts/progress_auto.ts'
import { detectPotentialStaleGuidance } from '../artifacts/guidance_staleness.ts'
import { ensureGeneratedAgentsMaps } from '../artifacts/agents_bootstrap.ts'
import type { ContextService } from '../context/service.ts'
import { createTrackingPermissionStore } from './state/permissions.ts'
import { recordFinalSummary, syncCompactStateFromLoopState } from './state/compact.ts'
import {
  createRuntimeState,
  restoreRuntimeState,
  snapshotRuntimeState,
  type RuntimeState,
  type RuntimeStateSnapshot,
} from './state/types.ts'
import { buildExecutionCharter, renderExecutionCharter } from './execution_charter.ts'
import {
  deriveTaskControl,
  resolveCapabilityProfileEpoch,
  type TaskControlDecision,
  type SchemaChangeReason,
  type TaskState,
} from './task_state.ts'
import type { SandboxBackend } from '../sandbox/backend.ts'
import type { ResolvedSandboxPolicy } from '../sandbox/policy.ts'
import { buildRegistryFromPool } from '../tools/builtin/index.ts'
import { applyCapabilityProfile, inferCapabilityProfileFromToolNames } from '../tools/pool.ts'
import {
  collectGitWorkingTreePaths,
  collectLatestCommitPaths,
  extractChangedPathsFromToolCall,
} from './workspace_changes.ts'

interface UsageTrackerLike {
  record: (usage: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
  }) => UsageSnapshot
}

export interface QueryEngineOptions {
  cwd: string
  provider: ModelProvider
  registry: ToolRegistry
  permissions: PermissionStore
  sandboxPolicy?: ResolvedSandboxPolicy
  sandboxBackend?: SandboxBackend
  contextService: ContextService
  model?: string
  sessionId?: string
  maxTurns?: number
  initialItems?: ConversationItem[]
  initialProjection?: Omit<PersistedConversationProjection, 'items'>
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  buildIntentContract?: (prompt: string, options?: { primaryObjective?: string }) => string | undefined
  deriveTaskControl?: (prompt: string, previousTask?: TaskState | null) => TaskControlDecision
  sink?: RuntimeSink
  promptObservabilityTracker?: {
    record: (
      turn: number,
      input: {
        stablePrefixItems: ConversationItem[]
        overlayItems: ConversationItem[]
        transcriptItems: ConversationItem[]
        tools?: ReturnType<ToolRegistry['getAll']>
        schemaChangeReason?: SchemaChangeReason | null
      }
    ) => PromptObservabilitySnapshot
  }
  persistItem?: (item: ConversationItem, origin: 'provider_output' | 'local_tool_output' | 'local_runtime', runtimeResponseId?: string) => Promise<void> | void
  persistResponseBoundary?: (boundary: ProviderResponseBoundary) => Promise<void> | void
  persistUsage?: (entry: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
    provider?: string
    runtimeResponseId?: string
    providerResponseId?: string
    providerFinishReason?: string
    promptObservability?: PromptObservabilitySnapshot
    model?: string
    toolSchemaTokensEstimate?: number
    sessionId?: string
  }) => Promise<void> | void
  usageTracker?: UsageTrackerLike
  usageRates?: UsageRates
  toolSchemaTokensEstimate?: number
  createSubagentRuntime?: (context: {
    prompt: string
    historyProjection: PersistedConversationProjection
    runtimeState: RuntimeState
    sessionId?: string
    model?: string
    depth: number
  }) => SubagentToolRuntime
}

export interface QueryEngineSnapshot {
  items: ConversationItem[]
  stablePrefixItems: ConversationItem[]
  transcriptTailItems: ConversationItem[]
  runtimeState: RuntimeStateSnapshot
  generatedMapMode: boolean
}

function collectObservedToolNames(items: ConversationItem[]): string[] {
  const names = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'function_call') continue
    const name = item.name.trim()
    if (name !== '') names.add(name)
  }
  return [...names]
}

export class QueryEngine {
  private readonly options: QueryEngineOptions
  private readonly runtimeState: RuntimeState
  private readonly trackedPermissions: PermissionStore
  private stablePrefixItems: ConversationItem[]
  private transcriptTailItems: ConversationItem[]
  private initialized = false
  private startupMapSummary: string | null = null
  private lastWorkingTreeFingerprint: string | null = null

  constructor(options: QueryEngineOptions) {
    this.options = options
    this.runtimeState = createRuntimeState()
    this.trackedPermissions = createTrackingPermissionStore(options.permissions, this.runtimeState.permissions)
    const initialState = options.initialProjection
      ? projectPersistentConversationItems([
          ...options.initialProjection.stablePrefixItems,
          ...options.initialProjection.transcriptTailItems,
        ])
      : projectPersistentConversationItems(options.initialItems ?? [])
    this.stablePrefixItems = initialState.stablePrefixItems
    this.transcriptTailItems = initialState.transcriptTailItems
  }

  getStartupMapSummary(): string | null {
    return this.startupMapSummary
  }

  async initialize(): Promise<void> {
    await this.ensureInitialized()
  }

  getItems(): ConversationItem[] {
    return [
      ...this.stablePrefixItems,
      ...this.transcriptTailItems,
    ]
  }

  getPersistedProjection(): PersistedConversationProjection {
    return {
      stablePrefixItems: [...this.stablePrefixItems],
      transcriptTailItems: [...this.transcriptTailItems],
      items: this.getItems(),
    }
  }

  getRuntimeState(): RuntimeState {
    return this.runtimeState
  }

  async resumeFromTranscript(items: ConversationItem[]): Promise<void> {
    const persistentState = projectPersistentConversationItems(items)
    this.stablePrefixItems = persistentState.stablePrefixItems
    this.transcriptTailItems = persistentState.transcriptTailItems
    this.runtimeState.task.currentTask = null
    this.runtimeState.task.mutationPolicy = null
    this.runtimeState.task.charter = null
    this.runtimeState.task.capabilityProfile = inferCapabilityProfileFromToolNames(
      collectObservedToolNames(persistentState.items)
    )
    this.runtimeState.task.profileEpoch = {
      epoch: 0,
      lastSchemaChangeReason: null,
      pendingResumeRehydration: persistentState.items.length > 0,
    }
    this.initialized = true
  }

  async resumeFromSnapshot(snapshot: QueryEngineSnapshot): Promise<void> {
    const persistentState = projectPersistentConversationItems(
      snapshot.stablePrefixItems && snapshot.transcriptTailItems
        ? [...snapshot.stablePrefixItems, ...snapshot.transcriptTailItems]
        : snapshot.items
    )
    this.stablePrefixItems = persistentState.stablePrefixItems
    this.transcriptTailItems = persistentState.transcriptTailItems
    restoreRuntimeState(this.runtimeState, snapshot.runtimeState)
    this.options.contextService.setGeneratedMapMode(snapshot.generatedMapMode)
    this.initialized = true
  }

  getSnapshot(): QueryEngineSnapshot {
    const projection = this.getPersistedProjection()
    return {
      items: projection.items,
      stablePrefixItems: projection.stablePrefixItems,
      transcriptTailItems: projection.transcriptTailItems,
      runtimeState: snapshotRuntimeState(this.runtimeState),
      generatedMapMode: this.options.contextService.getGeneratedMapMode(),
    }
  }

  private async persistItem(
    item: ConversationItem,
    origin: 'provider_output' | 'local_tool_output' | 'local_runtime',
    runtimeResponseId?: string,
  ): Promise<void> {
    await this.options.persistItem?.(item, origin, runtimeResponseId)
  }

  private async applyPostRunMaintenance(params: {
    changedFiles: Set<string>
    sawSuccessfulGitCommit: boolean
    sawWorkspaceMutationSignal: boolean
  }): Promise<void> {
    const changedFiles = params.changedFiles
    let workingTreeSnapshotChanged = false

    if (params.sawWorkspaceMutationSignal || params.sawSuccessfulGitCommit) {
      const workingTreePaths = collectGitWorkingTreePaths(this.options.cwd)
      const fingerprint = [...new Set(workingTreePaths)].sort().join('\n')
      if (fingerprint !== this.lastWorkingTreeFingerprint) {
        workingTreeSnapshotChanged = true
        this.lastWorkingTreeFingerprint = fingerprint
        for (const item of workingTreePaths) changedFiles.add(item)
      }
    }
    if (params.sawSuccessfulGitCommit) {
      for (const item of collectLatestCommitPaths(this.options.cwd)) changedFiles.add(item)
    }

    if (changedFiles.size > 0) {
      try {
        await updateCodebaseIndexWithChangedFiles(this.options.cwd, [...changedFiles])
        this.options.sink?.onMapUpdated(
          `codebase index updated (${changedFiles.size} changed file${changedFiles.size === 1 ? '' : 's'})`
        )
      } catch (error) {
        process.stderr.write(`Codebase index update warning: ${String(error)}\n`)
      }
    }

    try {
      const progressUpdate = await updateProgressFromRuntimeSignals(this.options.cwd, {
        changedPaths: [...changedFiles],
        sawSuccessfulGitCommit: params.sawSuccessfulGitCommit,
      })
      if (progressUpdate.updated) {
        this.options.sink?.onPhaseUpdate('阶段更新：progress 快照已同步到 .merlion/progress.md。')
      }
    } catch (error) {
      process.stderr.write(`Progress auto-update warning: ${String(error)}\n`)
    }

    if (changedFiles.size > 0) {
      try {
        const staleHints = await detectPotentialStaleGuidance(this.options.cwd, [...changedFiles])
        if (staleHints.length > 0) {
          const preview = staleHints.map((hint) => hint.guidanceFile).join(', ')
          this.options.sink?.onMapUpdated(`guidance may be stale after code changes: ${preview}`)
        }
      } catch (error) {
        process.stderr.write(`Guidance staleness warning: ${String(error)}\n`)
      }
    }

    if (this.options.contextService.getGeneratedMapMode() && (params.sawSuccessfulGitCommit || workingTreeSnapshotChanged)) {
      try {
        const refreshed = await ensureGeneratedAgentsMaps(this.options.cwd, {
          force: workingTreeSnapshotChanged && !params.sawSuccessfulGitCommit,
        })
        if (refreshed.created) {
          this.options.sink?.onMapUpdated(
            `generated project map refreshed (${refreshed.generatedFiles.length} scope${refreshed.generatedFiles.length === 1 ? '' : 's'})`
          )
        } else if (params.sawSuccessfulGitCommit) {
          this.options.sink?.onMapUpdated('generated project map checked (up to date)')
        }
      } catch (error) {
        process.stderr.write(`Generated map refresh warning: ${String(error)}\n`)
      }
    }
  }

  private async executeLoop(prompt: string): Promise<{
    result: RunLoopResult
    changedFiles: Set<string>
    sawSuccessfulGitCommit: boolean
    sawWorkspaceMutationSignal: boolean
  }> {
    const changedFiles = new Set<string>()
    const toolPathSignals = new Set<string>()
    let sawSuccessfulGitCommit = false
    let sawWorkspaceMutationSignal = false
    const candidateTaskControl = (this.options.deriveTaskControl ?? deriveTaskControl)(
      prompt,
      this.runtimeState.task.currentTask,
    )
    const profileResolution = resolveCapabilityProfileEpoch({
      prompt,
      previousTask: this.runtimeState.task.currentTask,
      previousCapabilityProfile: this.runtimeState.task.capabilityProfile,
      candidateTaskState: candidateTaskControl.taskState,
      pendingResumeRehydration: this.runtimeState.task.profileEpoch.pendingResumeRehydration,
    })
    const taskControl: TaskControlDecision = {
      ...candidateTaskControl,
      capabilityProfile: profileResolution.capabilityProfile,
    }
    const charter = buildExecutionCharter(
      taskControl.taskState,
      taskControl.capabilityProfile,
      taskControl.mutationPolicy,
    )
    const charterText = renderExecutionCharter(taskControl.taskState, charter)
    this.runtimeState.task.currentTask = {
      ...taskControl.taskState,
      explicitPaths: [...taskControl.taskState.explicitPaths],
      openQuestions: [...taskControl.taskState.openQuestions],
      correctionNotes: taskControl.taskState.correctionNotes ? [...taskControl.taskState.correctionNotes] : undefined,
    }
    this.runtimeState.task.capabilityProfile = taskControl.capabilityProfile
    this.runtimeState.task.mutationPolicy = {
      ...taskControl.mutationPolicy,
      writableScopes: taskControl.mutationPolicy.writableScopes ? [...taskControl.mutationPolicy.writableScopes] : undefined,
    }
    this.runtimeState.task.charter = {
      ...charter,
      nonGoals: [...charter.nonGoals],
      correctionNotes: charter.correctionNotes ? [...charter.correctionNotes] : undefined,
    }
    this.runtimeState.task.profileEpoch = {
      epoch: profileResolution.schemaChangeReason
        ? this.runtimeState.task.profileEpoch.epoch + 1
        : Math.max(1, this.runtimeState.task.profileEpoch.epoch),
      lastSchemaChangeReason: profileResolution.schemaChangeReason,
      pendingResumeRehydration: false,
    }
    const turnRegistry = buildRegistryFromPool(applyCapabilityProfile(this.options.registry.getAll(), taskControl.capabilityProfile))
    const promptPreludeItems = await this.options.contextService.buildPromptPrelude(prompt)

    const result = await runLoop({
      provider: this.options.provider,
      registry: turnRegistry,
      systemPrompt: await this.options.contextService.getSystemPrompt(),
      userPrompt: prompt,
      intentContract: this.options.buildIntentContract?.(prompt, {
        primaryObjective: taskControl.taskState.activeObjective,
      }),
      promptPreludeItems,
      executionCharterText: charterText,
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      maxTurns: this.options.maxTurns ?? 100,
      permissions: this.trackedPermissions,
      sandboxPolicy: this.options.sandboxPolicy,
      sandboxBackend: this.options.sandboxBackend,
      askQuestions: this.options.askQuestions,
      stablePrefixItems: this.stablePrefixItems,
      initialItems: this.transcriptTailItems,
      persistInitialMessages: false,
      taskControl,
      schemaChangeReason: profileResolution.schemaChangeReason,
      subagents: this.options.createSubagentRuntime?.({
        prompt,
        historyProjection: this.getPersistedProjection(),
        runtimeState: this.runtimeState,
        sessionId: this.options.sessionId,
        model: this.options.model,
        depth: 0,
      }),
      promptObservabilityTracker: this.options.promptObservabilityTracker,
      onItemAppended: async (entry) => {
        await this.persistItem(entry.item, entry.origin, entry.runtimeResponseId)
      },
      onResponseBoundary: async (boundary) => {
        await this.options.persistResponseBoundary?.(boundary)
      },
      onUsage: async (usage) => {
        await this.options.persistUsage?.({
          ...usage,
          promptObservability: usage.promptObservability,
          model: this.options.model,
          toolSchemaTokensEstimate:
            usage.promptObservability?.tool_schema_tokens_estimate ?? this.options.toolSchemaTokensEstimate,
          sessionId: this.options.sessionId,
        })
        const snapshot = this.options.usageTracker?.record(usage)
        if (snapshot && this.options.sink) {
          const estimatedCost = this.options.usageRates ? calculateUsageCostUsd(snapshot.totals, this.options.usageRates) : undefined
          this.options.sink.onUsage({
            snapshot,
            estimatedCost,
            provider: usage.provider,
            promptObservability: usage.promptObservability,
            runtimeResponseId: usage.runtimeResponseId,
            providerResponseId: usage.providerResponseId,
            providerFinishReason: usage.providerFinishReason,
          })
        }
      },
      onTurnStart: ({ turn }) => {
        this.options.sink?.onTurnStart({ turn })
      },
      onAssistantResponse: ({ turn, finish_reason, tool_calls_count }) => {
        this.options.sink?.onAssistantResponse({ turn, finish_reason, tool_calls_count })
      },
      onSandboxEvent: (event) => {
        this.options.sink?.onSandboxEvent?.(event)
      },
      onToolCallStart: ({ call, index, total }) => {
        this.options.sink?.onToolStart({
          index,
          total,
          name: call.function.name,
          summary: call.function.arguments,
        })
      },
      onToolCallResult: async ({ call, index, total, durationMs, isError, uiPayload, message }) => {
        this.options.sink?.onToolResult({
          index,
          total,
          name: call.function.name,
          isError,
          durationMs,
          uiPayload,
        })
        if (!isError) {
          const changedFromCall = extractChangedPathsFromToolCall(call.function.name, call.function.arguments)
          for (const item of changedFromCall) changedFiles.add(item)
          if (changedFromCall.length > 0 || call.function.name === 'bash' || call.function.name === 'run_script') {
            sawWorkspaceMutationSignal = true
          }
        }
        const candidates = await this.options.contextService.extractCandidatePathsFromToolEvent({
          call,
          message,
        })
        for (const candidate of candidates) toolPathSignals.add(candidate)
      },
      onToolBatchComplete: async ({ results }) => {
        for (const line of summarizeToolBatchMilestones(results)) {
          this.options.sink?.onPhaseUpdate(line)
        }
        if (detectSuccessfulGitCommit(results)) sawSuccessfulGitCommit = true
        if (results.length === 0 && toolPathSignals.size === 0) return
        const guidance = await this.options.contextService.buildPathGuidanceItems([...toolPathSignals])
        if (guidance.loadedFiles.length > 0) {
          this.options.sink?.onMapUpdated(
            `guidance updated (${guidance.loadedFiles.length} file${guidance.loadedFiles.length === 1 ? '' : 's'}): ${guidance.loadedFiles.join(', ')}`
          )
        }
        return guidance.items
      },
    })

    return {
      result,
      changedFiles,
      sawSuccessfulGitCommit,
      sawWorkspaceMutationSignal,
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    const systemPrompt = await this.options.contextService.getSystemPrompt()
    const bootstrap = await this.options.contextService.prefetchIfSafe()
    this.startupMapSummary = bootstrap.startupMapSummary
    this.options.contextService.setGeneratedMapMode(bootstrap.generatedMapMode)

    if (this.stablePrefixItems.length === 0) {
      this.stablePrefixItems = [
        createSystemItem(systemPrompt, 'static'),
        ...bootstrap.initialItems,
      ]
      for (const item of this.stablePrefixItems) {
        await this.persistItem(item, 'local_runtime')
      }
    }
    this.initialized = true
  }

  async submitPrompt(prompt: string): Promise<RunLoopResult> {
    await this.ensureInitialized()
    const execution = await this.executeLoop(prompt)
    await this.applyPostRunMaintenance({
      changedFiles: execution.changedFiles,
      sawSuccessfulGitCommit: execution.sawSuccessfulGitCommit,
      sawWorkspaceMutationSignal: execution.sawWorkspaceMutationSignal,
    })

    const persistentState = projectPersistentConversationItems(execution.result.state.items)
    this.stablePrefixItems = persistentState.stablePrefixItems
    this.transcriptTailItems = persistentState.transcriptTailItems
    syncCompactStateFromLoopState(this.runtimeState.compact, execution.result.state)
    recordFinalSummary(this.runtimeState.compact, execution.result.finalText)
    return execution.result
  }
}
