import type { ModelProvider } from '../types.js'
import type { ConversationItem, ProviderResponseBoundary } from './items.ts'
import { createSystemItem } from './items.ts'
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
import { createRuntimeState, snapshotRuntimeState, type RuntimeState, type RuntimeStateSnapshot } from './state/types.ts'
import type { SandboxBackend } from '../sandbox/backend.ts'
import type { ResolvedSandboxPolicy } from '../sandbox/policy.ts'
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
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  buildIntentContract?: (prompt: string) => string | undefined
  sink?: RuntimeSink
  promptObservabilityTracker?: {
    record: (turn: number, items: ConversationItem[]) => PromptObservabilitySnapshot
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
    history: ConversationItem[]
    runtimeState: RuntimeState
    sessionId?: string
    model?: string
    depth: number
  }) => SubagentToolRuntime
}

export interface QueryEngineSnapshot {
  items: ConversationItem[]
  runtimeState: RuntimeStateSnapshot
  generatedMapMode: boolean
}

export class QueryEngine {
  private readonly options: QueryEngineOptions
  private readonly runtimeState: RuntimeState
  private readonly trackedPermissions: PermissionStore
  private history: ConversationItem[]
  private initialized = false
  private startupMapSummary: string | null = null
  private lastWorkingTreeFingerprint: string | null = null

  constructor(options: QueryEngineOptions) {
    this.options = options
    this.runtimeState = createRuntimeState()
    this.trackedPermissions = createTrackingPermissionStore(options.permissions, this.runtimeState.permissions)
    this.history = options.initialItems ? [...options.initialItems] : []
  }

  getStartupMapSummary(): string | null {
    return this.startupMapSummary
  }

  async initialize(): Promise<void> {
    await this.ensureInitialized()
  }

  getItems(): ConversationItem[] {
    return [...this.history]
  }

  getRuntimeState(): RuntimeState {
    return this.runtimeState
  }

  async resumeFromTranscript(items: ConversationItem[]): Promise<void> {
    this.history = [...items]
    this.initialized = true
  }

  getSnapshot(): QueryEngineSnapshot {
    return {
      items: [...this.history],
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

  private async createPromptSeed(prompt: string): Promise<ConversationItem[]> {
    return [
      ...this.history,
      ...await this.options.contextService.buildPromptPrelude(prompt),
    ]
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
    let latestPromptObservability: PromptObservabilitySnapshot | undefined
    const seededItems = await this.createPromptSeed(prompt)

    const result = await runLoop({
      provider: this.options.provider,
      registry: this.options.registry,
      systemPrompt: await this.options.contextService.getSystemPrompt(),
      userPrompt: prompt,
      intentContract: this.options.buildIntentContract?.(prompt),
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      maxTurns: this.options.maxTurns ?? 100,
      permissions: this.trackedPermissions,
      sandboxPolicy: this.options.sandboxPolicy,
      sandboxBackend: this.options.sandboxBackend,
      askQuestions: this.options.askQuestions,
      initialItems: seededItems,
      persistInitialMessages: false,
      subagents: this.options.createSubagentRuntime?.({
        prompt,
        history: [...this.history],
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
          promptObservability: latestPromptObservability,
          model: this.options.model,
          toolSchemaTokensEstimate: this.options.toolSchemaTokensEstimate,
          sessionId: this.options.sessionId,
        })
        const snapshot = this.options.usageTracker?.record(usage)
        if (snapshot && this.options.sink) {
          const estimatedCost = this.options.usageRates ? calculateUsageCostUsd(snapshot.totals, this.options.usageRates) : undefined
          this.options.sink.onUsage({
            snapshot,
            estimatedCost,
            provider: usage.provider,
            promptObservability: latestPromptObservability,
            runtimeResponseId: usage.runtimeResponseId,
            providerResponseId: usage.providerResponseId,
            providerFinishReason: usage.providerFinishReason,
          })
        }
      },
      onPromptObservability: (snapshot) => {
        latestPromptObservability = snapshot
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
    const initialItems = [
      createSystemItem(systemPrompt, 'static'),
      ...bootstrap.initialItems,
      ...this.history,
    ]
    this.history = initialItems
    for (const item of initialItems) {
      await this.persistItem(item, 'local_runtime')
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

    this.history = [...execution.result.state.items]
    syncCompactStateFromLoopState(this.runtimeState.compact, execution.result.state)
    recordFinalSummary(this.runtimeState.compact, execution.result.finalText)
    return execution.result
  }
}
