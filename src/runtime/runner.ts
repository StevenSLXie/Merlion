import { execSync } from 'node:child_process'

import { askLine } from '../cli/ask.ts'
import { runReplSession } from '../cli/repl.ts'
import { createPermissionStore } from '../permissions/store.ts'
import { createPromptSectionCache } from '../prompt/sections.ts'
import { buildMerlionSystemPrompt } from '../prompt/system_prompt.ts'
import { OpenAICompatProvider } from '../providers/openai.ts'
import type { PromptObservabilitySnapshot } from './prompt_observability.ts'
import { createPromptObservabilityTrackerWithToolSchema } from './prompt_observability.ts'
import { detectSuccessfulGitCommit, summarizeToolBatchMilestones } from './tool_batch_milestones.ts'
import { buildIntentContract } from './intent_contract.ts'
import { runLoop } from './loop.ts'
import {
  appendSessionMeta,
  appendTranscriptMessage,
  appendUsage,
  createSessionFiles,
  getSessionFilesForResume,
  loadSessionMessages,
} from './session.ts'
import { calculateUsageCostUsd, createUsageTracker, type UsageRates } from './usage.ts'
import { loadAgentsGuidance } from '../artifacts/agents.ts'
import { ensureGeneratedAgentsMaps } from '../artifacts/agents_bootstrap.ts'
import {
  refreshCodebaseIndex,
  updateCodebaseIndexWithChangedFiles,
} from '../artifacts/codebase_index.ts'
import { detectPotentialStaleGuidance } from '../artifacts/guidance_staleness.ts'
import { updateProgressFromRuntimeSignals } from '../artifacts/progress_auto.ts'
import { buildOrientationContext } from '../context/orientation.ts'
import {
  buildPathGuidanceDelta,
  createPathGuidanceState,
  extractCandidatePathsFromToolEvent,
} from '../context/path_guidance.ts'
import { buildDefaultRegistry } from '../tools/builtin/index.ts'
import { discoverVerificationChecks } from '../verification/checks.ts'
import { runVerificationFixRounds } from '../verification/fix_round.ts'
import { runVerificationChecks } from '../verification/runner.ts'
import { runConfigWizard } from '../config/wizard.ts'
import type { MerlionProvider } from '../config/store.ts'
import { CliRuntimeSink } from './sinks/cli.ts'
import { launchWeixinSinkMode } from './sinks/wechat.ts'

export interface CliRuntimeOptions {
  task: string
  provider: MerlionProvider
  model: string
  baseURL: string
  apiKey: string
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
  resumeSessionId?: string
  repl: boolean
  verify: boolean
}

function isAuthFailureResult(result: { output: string; terminal: string }): boolean {
  if (result.terminal !== 'model_error') return false
  return /Provider authentication failed \(401\/403\)\./i.test(result.output)
}

function serializeToolSchema(registry: ReturnType<typeof buildDefaultRegistry>): string {
  return JSON.stringify(registry.getAll().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })))
}

function estimateToolSchemaTokens(registry: ReturnType<typeof buildDefaultRegistry>): number {
  const serialized = serializeToolSchema(registry)
  return Math.ceil(serialized.length / 4)
}

function parseEnvNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function loadUsageRatesFromEnv(): UsageRates | undefined {
  const input = parseEnvNumber('MERLION_COST_INPUT_PER_1M')
  const output = parseEnvNumber('MERLION_COST_OUTPUT_PER_1M')
  if (input === undefined || output === undefined) return undefined
  const cached = parseEnvNumber('MERLION_COST_CACHED_INPUT_PER_1M')
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cachedInputPerMillion: cached
  }
}

function loadOrientationBudgetsFromEnv(): Partial<{
  totalTokens: number
  agentsTokens: number
  progressTokens: number
  indexTokens: number
}> {
  const totalTokens = parseEnvNumber('MERLION_ORIENTATION_TOTAL_TOKENS')
  const agentsTokens = parseEnvNumber('MERLION_ORIENTATION_AGENTS_TOKENS')
  const progressTokens = parseEnvNumber('MERLION_ORIENTATION_PROGRESS_TOKENS')
  const indexTokens = parseEnvNumber('MERLION_ORIENTATION_INDEX_TOKENS')
  return {
    totalTokens,
    agentsTokens,
    progressTokens,
    indexTokens
  }
}

function loadPathGuidanceBudgetsFromEnv(): Partial<{
  totalTokens: number
  perFileTokens: number
  maxFiles: number
}> {
  const totalTokens = parseEnvNumber('MERLION_PATH_GUIDANCE_TOTAL_TOKENS')
  const perFileTokens = parseEnvNumber('MERLION_PATH_GUIDANCE_PER_FILE_TOKENS')
  const maxFiles = parseEnvNumber('MERLION_PATH_GUIDANCE_MAX_FILES')
  return {
    totalTokens,
    perFileTokens,
    maxFiles
  }
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

export async function runCliRuntime(options: CliRuntimeOptions): Promise<number> {
  let provider = new OpenAICompatProvider({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    model: options.model
  })
  const registry = buildDefaultRegistry()
  const toolSchemaSerialized = serializeToolSchema(registry)
  const permissions = createPermissionStore(options.permissionMode)
  const session = options.resumeSessionId
    ? await getSessionFilesForResume(options.cwd, options.resumeSessionId)
    : await createSessionFiles(options.cwd)
  if (!options.resumeSessionId) {
    await appendSessionMeta(session.transcriptPath, session.sessionId, options.model, options.cwd)
  }
  const toolSchemaTokensEstimate = estimateToolSchemaTokens(registry)
  const promptObservabilityTracker = createPromptObservabilityTrackerWithToolSchema(toolSchemaSerialized)
  const initialMessagesFromResume = options.resumeSessionId
    ? await loadSessionMessages(session.transcriptPath)
    : undefined
  const initialMessages = initialMessagesFromResume ?? [
    { role: 'system' as const, content: 'You are Merlion, a coding agent. Use tools to complete the task.' }
  ]
  let startupMapSummary: string | null = null
  let generatedMapMode = false
  if (!options.resumeSessionId && initialMessages.length > 0) {
    try {
      const bootstrap = await ensureGeneratedAgentsMaps(options.cwd)
      generatedMapMode =
        bootstrap.created ||
        bootstrap.generatedFiles.some((file) => file.replace(/\\/g, '/').includes('.merlion/maps/'))
      if (bootstrap.created) {
        startupMapSummary =
          `initialized generated project map (${bootstrap.generatedFiles.length} scope` +
          `${bootstrap.generatedFiles.length === 1 ? '' : 's'})`
      } else if (bootstrap.generatedFiles.length > 0) {
        startupMapSummary =
          `generated project map up to date (${bootstrap.generatedFiles.length} scope` +
          `${bootstrap.generatedFiles.length === 1 ? '' : 's'})`
      }
    } catch (error) {
      process.stderr.write(`Agents map bootstrap warning: ${String(error)}\n`)
    }
    await appendTranscriptMessage(session.transcriptPath, initialMessages[0]!)
    try {
      await refreshCodebaseIndex(options.cwd)
      const orientation = await buildOrientationContext(options.cwd, loadOrientationBudgetsFromEnv())
      if (orientation.text.trim() !== '') {
        const orientationMessage = {
          role: 'system' as const,
          content:
            'Project orientation context. Use this as a starting map, then verify with tools before edits.\n\n' +
            orientation.text
        }
        initialMessages.push(orientationMessage)
        await appendTranscriptMessage(session.transcriptPath, orientationMessage)
      }
    } catch (error) {
      process.stderr.write(`Orientation build warning: ${String(error)}\n`)
    }
  }

  const promptSectionCache = createPromptSectionCache()
  const systemPrompt = (
    await buildMerlionSystemPrompt({
      cwd: options.cwd,
      sectionCache: promptSectionCache
    })
  ).text
  let history = initialMessages
  const usageTracker = createUsageTracker()
  const usageRates = loadUsageRatesFromEnv()
  const pathGuidanceBudgets = loadPathGuidanceBudgetsFromEnv()
  const pathGuidanceState = createPathGuidanceState()
  let lastWorkingTreeFingerprint: string | null = null
  const sink = new CliRuntimeSink({
    model: options.model,
    sessionId: session.sessionId,
    isRepl: options.repl
  })

  sink.renderBanner()
  if (startupMapSummary) {
    sink.onMapUpdated(startupMapSummary)
  }

  try {
    const seeded = await loadAgentsGuidance(options.cwd, { maxTokens: 1 })
    if (seeded.files.some((file) => file.replace(/\\/g, '/').includes('/.merlion/maps/'))) {
      generatedMapMode = true
    }
    for (const file of seeded.files) {
      pathGuidanceState.loadedAgentFiles.add(file)
    }
  } catch (error) {
    process.stderr.write(`Path guidance seed warning: ${String(error)}\n`)
  }

  async function applyWizardConfig(): Promise<boolean> {
    const result = await runConfigWizard({
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      baseURL: options.baseURL
    }, undefined, {
      forceProviderPrompt: true,
      forceBaseURLPrompt: true,
      forceApiKeyPrompt: true,
      requireApiKeyInput: true
    })
    if (!result.ok) return false

    if (result.config.provider) options.provider = result.config.provider
    if (result.config.apiKey) options.apiKey = result.config.apiKey
    if (result.config.model) options.model = result.config.model
    if (typeof result.config.baseURL === 'string') options.baseURL = result.config.baseURL

    provider = new OpenAICompatProvider({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.model
    })
    return true
  }

  const runTurn = async (prompt: string) => {
    const changedFiles = new Set<string>()
    const toolPathSignals = new Set<string>()
    let sawSuccessfulGitCommit = false
    let sawWorkspaceMutationSignal = false
    let workingTreeSnapshotChanged = false
    let latestPromptObservability: PromptObservabilitySnapshot | undefined
    const intentContract = buildIntentContract(prompt) ?? undefined
    const result = await runLoop({
      provider,
      registry,
      systemPrompt,
      userPrompt: prompt,
      intentContract,
      cwd: options.cwd,
      maxTurns: 100,
      permissions,
      initialMessages: history,
      persistInitialMessages: false,
      onMessageAppended: async (message) => {
        await appendTranscriptMessage(session.transcriptPath, message)
      },
      onUsage: async (usage) => {
        await appendUsage(session.usagePath, {
          timestamp: new Date().toISOString(),
          session_id: session.sessionId,
          model: options.model,
          provider: usage.provider,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cached_tokens: usage.cached_tokens ?? null,
          tool_schema_tokens_estimate: toolSchemaTokensEstimate,
          prompt_observability: latestPromptObservability
        })
        const snapshot = usageTracker.record(usage)
        const estimatedCost = usageRates ? calculateUsageCostUsd(snapshot.totals, usageRates) : undefined
        sink.onUsage({
          snapshot,
          estimatedCost,
          provider: usage.provider,
          promptObservability: latestPromptObservability
        })
      },
      onPromptObservability: (snapshot) => {
        latestPromptObservability = snapshot
      },
      promptObservabilityTracker,
      onTurnStart: ({ turn }) => {
        sink.onTurnStart({ turn })
      },
      onAssistantResponse: ({ turn, finish_reason, tool_calls_count }) => {
        sink.onAssistantResponse({ turn, finish_reason, tool_calls_count })
      },
      onToolCallStart: ({ call, index, total }) => {
        sink.onToolStart({
          index,
          total,
          name: call.function.name,
          summary: call.function.arguments
        })
      },
      onToolCallResult: async ({ call, index, total, durationMs, isError, uiPayload, message }) => {
        sink.onToolResult({
          index,
          total,
          name: call.function.name,
          isError,
          durationMs,
          uiPayload
        })
        if (!isError) {
          const changedFromCall = extractChangedPathsFromToolCall(call.function.name, call.function.arguments)
          for (const path of changedFromCall) {
            changedFiles.add(path)
          }
          if (changedFromCall.length > 0 || call.function.name === 'bash' || call.function.name === 'run_script') {
            sawWorkspaceMutationSignal = true
          }
        }
        const candidates = await extractCandidatePathsFromToolEvent(options.cwd, {
          call,
          message
        })
        for (const candidate of candidates) toolPathSignals.add(candidate)
      },
      onToolBatchComplete: async ({ results }) => {
        for (const line of summarizeToolBatchMilestones(results)) {
          sink.onPhaseUpdate(line)
        }
        if (detectSuccessfulGitCommit(results)) {
          sawSuccessfulGitCommit = true
        }
        if (results.length === 0 && toolPathSignals.size === 0) return
        const delta = await buildPathGuidanceDelta(
          options.cwd,
          [...toolPathSignals],
          pathGuidanceState,
          pathGuidanceBudgets,
        )
        if (delta.text.trim() === '') return
        sink.onMapUpdated(
          `guidance updated (${delta.loadedFiles.length} file${delta.loadedFiles.length === 1 ? '' : 's'}): ${delta.loadedFiles.join(', ')}`
        )
        return [
          {
            role: 'system' as const,
            content:
              'Path guidance update. Use this to narrow your next tool calls before broad scans.\n\n' +
              delta.text
          }
        ]
      },
    })
    if (sawWorkspaceMutationSignal || sawSuccessfulGitCommit) {
      const workingTreePaths = collectGitWorkingTreePaths(options.cwd)
      const fingerprint = [...new Set(workingTreePaths)].sort().join('\n')
      if (fingerprint !== lastWorkingTreeFingerprint) {
        workingTreeSnapshotChanged = true
        lastWorkingTreeFingerprint = fingerprint
        for (const path of workingTreePaths) {
          changedFiles.add(path)
        }
      }
    }
    if (sawSuccessfulGitCommit) {
      for (const path of collectLatestCommitPaths(options.cwd)) {
        changedFiles.add(path)
      }
    }

    if (changedFiles.size > 0) {
      try {
        await updateCodebaseIndexWithChangedFiles(options.cwd, [...changedFiles])
        sink.onMapUpdated(
          `codebase index updated (${changedFiles.size} changed file${changedFiles.size === 1 ? '' : 's'})`
        )
      } catch (error) {
        process.stderr.write(`Codebase index update warning: ${String(error)}\n`)
      }
    }

    try {
      const progressUpdate = await updateProgressFromRuntimeSignals(options.cwd, {
        changedPaths: [...changedFiles],
        sawSuccessfulGitCommit,
      })
      if (progressUpdate.updated) {
        sink.onPhaseUpdate('阶段更新：progress 快照已同步到 .merlion/progress.md。')
      }
    } catch (error) {
      process.stderr.write(`Progress auto-update warning: ${String(error)}\n`)
    }

    if (changedFiles.size > 0) {
      try {
        const staleHints = await detectPotentialStaleGuidance(options.cwd, [...changedFiles])
        if (staleHints.length > 0) {
          const preview = staleHints.map((hint) => hint.guidanceFile).join(', ')
          sink.onMapUpdated(`guidance may be stale after code changes: ${preview}`)
        }
      } catch (error) {
        process.stderr.write(`Guidance staleness warning: ${String(error)}\n`)
      }
    }

    if (generatedMapMode && (sawSuccessfulGitCommit || workingTreeSnapshotChanged)) {
      try {
        const refreshed = await ensureGeneratedAgentsMaps(options.cwd, {
          force: workingTreeSnapshotChanged && !sawSuccessfulGitCommit
        })
        if (refreshed.created) {
          sink.onMapUpdated(
            `generated project map refreshed (${refreshed.generatedFiles.length} scope${refreshed.generatedFiles.length === 1 ? '' : 's'})`
          )
        } else if (sawSuccessfulGitCommit) {
          sink.onMapUpdated('generated project map checked (up to date)')
        }
      } catch (error) {
        process.stderr.write(`Generated map refresh warning: ${String(error)}\n`)
      }
    }
    history = result.state.messages
    return result
  }

  if (options.repl) {
    await runReplSession({
      readLine: async () => {
        return await askLine('')
      },
      write: (text) => {
        process.stdout.write(text)
      },
      runTurn: async (prompt) => {
        const result = await runTurn(prompt)
        return { output: result.finalText, terminal: result.terminal }
      },
      promptLabel: sink.promptLabel(),
      startupMessage: false,
      onPromptSubmitted: (prompt) => {
        sink.clearTypedInputLine()
        sink.renderUserPrompt(prompt)
      },
      onTurnResult: async (result) => {
        sink.renderAssistantOutput(result.output, result.terminal)
        if (!isAuthFailureResult(result)) return
        sink.stopSpinner()
        const answer = (await askLine('Provider auth failed. Re-run setup wizard now? [y/N]: ')) ?? ''
        const yes = /^(y|yes)$/i.test(answer.trim())
        if (!yes) {
          process.stdout.write('Tip: run `merlion config` any time to update your key/provider/model.\n')
          return
        }
        const ok = await applyWizardConfig()
        if (ok) {
          process.stdout.write('[config] Updated. Continue in REPL.\n')
        } else {
          process.stdout.write('[config] Setup aborted. Continue in REPL.\n')
        }
      },
      onSetDetailMode: (mode) => {
        sink.setToolDetailMode(mode)
      },
      onWechatLogin: async () => {
        sink.stopSpinner()
        process.stdout.write(
          '[wechat] Starting WeChat login + listen mode. Press Ctrl+C to return to REPL.\n'
        )
        await launchWeixinSinkMode({
          model: options.model,
          baseURL: options.baseURL,
          apiKey: options.apiKey,
          cwd: options.cwd,
          forceLogin: true,
          permissionMode: options.permissionMode,
        })
        process.stdout.write('[wechat] Listener stopped. Back to REPL.\n')
      },
    })
    sink.stopSpinner()
    return 0
  }

  sink.renderUserPrompt(options.task)
  let result = await runTurn(options.task)
  sink.renderAssistantOutput(result.finalText, result.terminal)
  if (isAuthFailureResult({ output: result.finalText, terminal: result.terminal })) {
    sink.stopSpinner()
    const answer = (await askLine('Provider auth failed. Re-run setup wizard now? [y/N]: ')) ?? ''
    if (/^(y|yes)$/i.test(answer.trim())) {
      const ok = await applyWizardConfig()
      if (ok) {
        process.stdout.write('[config] Updated. Retrying your request once...\n')
        result = await runTurn(options.task)
        sink.renderAssistantOutput(result.finalText, result.terminal)
      } else {
        process.stdout.write('[config] Setup aborted. You can run `merlion config` later.\n')
      }
    } else {
      process.stdout.write('Tip: run `merlion config` any time to update your key/provider/model.\n')
    }
  }
  if (result.terminal !== 'completed') {
    process.stderr.write(`Terminal state: ${result.terminal}\n`)
    return 1
  }

  if (!options.repl && options.verify) {
    const checks = await discoverVerificationChecks(options.cwd)
    if (checks.length > 0) {
      const verifyMaxRounds = Math.max(0, Math.floor(parseEnvNumber('MERLION_VERIFY_MAX_ROUNDS') ?? 2))
      const verifyTimeoutMs = Math.max(1000, Math.floor(parseEnvNumber('MERLION_VERIFY_TIMEOUT_MS') ?? 180_000))
      process.stdout.write(`[verify] discovered ${checks.length} checks\n`)

      const outcome = await runVerificationFixRounds({
        maxRounds: verifyMaxRounds,
        runVerification: async () =>
          runVerificationChecks({
            cwd: options.cwd,
            checks,
            timeoutMs: verifyTimeoutMs,
            onCheckResult: (item) => {
              process.stdout.write(`[verify] ${item.status} ${item.name} (${item.durationMs}ms)\n`)
            },
          }),
        runFixTurn: async (prompt, round) => {
          sink.renderUserPrompt(`[verification round ${round}] ${prompt}`)
          const fixResult = await runTurn(prompt)
          sink.renderAssistantOutput(fixResult.finalText, fixResult.terminal)
        },
        onRound: ({ round, action }) => {
          if (action === 'fix') {
            process.stdout.write(`[verify] round ${round + 1}: applying automatic fix attempt\n`)
          }
          if (action === 'pass') {
            process.stdout.write('[verify] all checks passed\n')
          }
        }
      })

      if (!outcome.passed) {
        process.stderr.write('[verify] failed after max fix rounds\n')
        return 1
      }
    } else {
      process.stdout.write('[verify] no checks discovered\n')
    }
  }

  return 0
}
