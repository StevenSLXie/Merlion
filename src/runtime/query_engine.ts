import { execSync } from 'node:child_process'

import type { ChatMessage, ModelProvider } from '../types.js'
import type { AskUserQuestionItem, PermissionStore } from '../tools/types.js'
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
  contextService: ContextService
  model?: string
  sessionId?: string
  maxTurns?: number
  initialMessages?: ChatMessage[]
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  buildIntentContract?: (prompt: string) => string | undefined
  sink?: RuntimeSink
  promptObservabilityTracker?: {
    record: (turn: number, messages: ChatMessage[]) => PromptObservabilitySnapshot
  }
  persistMessage?: (message: ChatMessage) => Promise<void> | void
  persistUsage?: (entry: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens?: number | null
    provider?: string
    promptObservability?: PromptObservabilitySnapshot
    model?: string
    toolSchemaTokensEstimate?: number
    sessionId?: string
  }) => Promise<void> | void
  usageTracker?: UsageTrackerLike
  usageRates?: UsageRates
  toolSchemaTokensEstimate?: number
}

export interface QueryEngineSnapshot {
  messages: ChatMessage[]
  runtimeState: RuntimeStateSnapshot
  generatedMapMode: boolean
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function extractChangedPathsFromToolCall(toolName: string, rawArgs: string): string[] {
  const args = parseToolArgs(rawArgs)
  const out: string[] = []
  const push = (value: unknown) => {
    const path = nonEmptyString(value)
    if (path) out.push(path)
  }

  if (
    toolName === 'create_file' ||
    toolName === 'write_file' ||
    toolName === 'append_file' ||
    toolName === 'edit_file' ||
    toolName === 'delete_file' ||
    toolName === 'mkdir'
  ) {
    push(args.path ?? args.file_path)
  } else if (toolName === 'copy_file') {
    push(args.to_path ?? args.path)
  } else if (toolName === 'move_file') {
    push(args.from_path)
    push(args.to_path)
  }

  return out
}

function decodePorcelainPath(value: string): string {
  const text = value.trim()
  if (!text.startsWith('"')) return text
  try {
    return JSON.parse(text) as string
  } catch {
    return text.slice(1, text.endsWith('"') ? -1 : undefined)
  }
}

function collectGitWorkingTreePaths(cwd: string): string[] {
  try {
    const output = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    if (output === '') return []

    const out: string[] = []
    for (const line of output.split('\n')) {
      if (line.length < 4) continue
      const payload = line.slice(3).trim()
      const arrow = payload.lastIndexOf(' -> ')
      const target = arrow >= 0 ? payload.slice(arrow + 4) : payload
      const normalized = decodePorcelainPath(target).replace(/\\/g, '/')
      if (normalized !== '') out.push(normalized)
      if (out.length >= 120) break
    }
    return out
  } catch {
    return []
  }
}

function collectLatestCommitPaths(cwd: string): string[] {
  try {
    const output = execSync('git show --name-only --pretty=format: --diff-filter=ACMR --no-renames -n 1 HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    if (output === '') return []
    const out: string[] = []
    for (const raw of output.split('\n')) {
      const normalized = decodePorcelainPath(raw).replace(/\\/g, '/').trim()
      if (normalized === '' || normalized.startsWith('..')) continue
      if (!out.includes(normalized)) out.push(normalized)
      if (out.length >= 80) break
    }
    return out
  } catch {
    return []
  }
}

export class QueryEngine {
  private readonly options: QueryEngineOptions
  private readonly runtimeState: RuntimeState
  private readonly trackedPermissions: PermissionStore
  private history: ChatMessage[]
  private initialized = false
  private startupMapSummary: string | null = null
  private lastWorkingTreeFingerprint: string | null = null

  constructor(options: QueryEngineOptions) {
    this.options = options
    this.runtimeState = createRuntimeState()
    this.trackedPermissions = createTrackingPermissionStore(options.permissions, this.runtimeState.permissions)
    this.history = [...(options.initialMessages ?? [])]
  }

  getStartupMapSummary(): string | null {
    return this.startupMapSummary
  }

  async initialize(): Promise<void> {
    await this.ensureInitialized()
  }

  getMessages(): ChatMessage[] {
    return [...this.history]
  }

  getRuntimeState(): RuntimeState {
    return this.runtimeState
  }

  async resumeFromTranscript(messages: ChatMessage[]): Promise<void> {
    this.history = [...messages]
    this.initialized = true
  }

  getSnapshot(): QueryEngineSnapshot {
    return {
      messages: [...this.history],
      runtimeState: snapshotRuntimeState(this.runtimeState),
      generatedMapMode: this.options.contextService.getGeneratedMapMode(),
    }
  }

  private async persistMessage(message: ChatMessage): Promise<void> {
    await this.options.persistMessage?.(message)
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    const systemPrompt = await this.options.contextService.getSystemPrompt()
    const bootstrap = await this.options.contextService.prefetchIfSafe()
    this.startupMapSummary = bootstrap.startupMapSummary
    this.options.contextService.setGeneratedMapMode(bootstrap.generatedMapMode)
    const initialMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...bootstrap.initialMessages,
      ...this.history,
    ]
    this.history = initialMessages
    for (const message of initialMessages) {
      await this.persistMessage(message)
    }
    this.initialized = true
  }

  async submitPrompt(prompt: string): Promise<RunLoopResult> {
    await this.ensureInitialized()
    const changedFiles = new Set<string>()
    const toolPathSignals = new Set<string>()
    let sawSuccessfulGitCommit = false
    let sawWorkspaceMutationSignal = false
    let workingTreeSnapshotChanged = false
    let latestPromptObservability: PromptObservabilitySnapshot | undefined
    const seededMessages = [
      ...this.history,
      ...(await this.options.contextService.buildPromptPrelude(prompt)),
    ]

    const result = await runLoop({
      provider: this.options.provider,
      registry: this.options.registry,
      systemPrompt: await this.options.contextService.getSystemPrompt(),
      userPrompt: prompt,
      intentContract: this.options.buildIntentContract?.(prompt),
      cwd: this.options.cwd,
      maxTurns: this.options.maxTurns ?? 100,
      permissions: this.trackedPermissions,
      askQuestions: this.options.askQuestions,
      initialMessages: seededMessages,
      persistInitialMessages: false,
      promptObservabilityTracker: this.options.promptObservabilityTracker,
      onMessageAppended: async (message) => {
        await this.persistMessage(message)
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
        const guidance = await this.options.contextService.buildPathGuidanceMessages([...toolPathSignals])
        if (guidance.loadedFiles.length > 0) {
          this.options.sink?.onMapUpdated(
            `guidance updated (${guidance.loadedFiles.length} file${guidance.loadedFiles.length === 1 ? '' : 's'}): ${guidance.loadedFiles.join(', ')}`
          )
        }
        return guidance.messages
      },
    })

    if (sawWorkspaceMutationSignal || sawSuccessfulGitCommit) {
      const workingTreePaths = collectGitWorkingTreePaths(this.options.cwd)
      const fingerprint = [...new Set(workingTreePaths)].sort().join('\n')
      if (fingerprint !== this.lastWorkingTreeFingerprint) {
        workingTreeSnapshotChanged = true
        this.lastWorkingTreeFingerprint = fingerprint
        for (const item of workingTreePaths) changedFiles.add(item)
      }
    }
    if (sawSuccessfulGitCommit) {
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
        sawSuccessfulGitCommit,
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

    if (this.options.contextService.getGeneratedMapMode() && (sawSuccessfulGitCommit || workingTreeSnapshotChanged)) {
      try {
        const refreshed = await ensureGeneratedAgentsMaps(this.options.cwd, {
          force: workingTreeSnapshotChanged && !sawSuccessfulGitCommit,
        })
        if (refreshed.created) {
          this.options.sink?.onMapUpdated(
            `generated project map refreshed (${refreshed.generatedFiles.length} scope${refreshed.generatedFiles.length === 1 ? '' : 's'})`
          )
        } else if (sawSuccessfulGitCommit) {
          this.options.sink?.onMapUpdated('generated project map checked (up to date)')
        }
      } catch (error) {
        process.stderr.write(`Generated map refresh warning: ${String(error)}\n`)
      }
    }

    this.history = result.state.messages
    syncCompactStateFromLoopState(this.runtimeState.compact, result.state)
    recordFinalSummary(this.runtimeState.compact, result.finalText)
    return result
  }
}
