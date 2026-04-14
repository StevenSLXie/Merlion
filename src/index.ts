import { cwd as currentCwd } from 'node:process'
import { execSync } from 'node:child_process'

import { askLine } from './cli/ask.ts'
import { CliExperience } from './cli/experience.ts'
import { runReplSession } from './cli/repl.ts'
import { createPermissionStore } from './permissions/store.ts'
import { OpenAICompatProvider } from './providers/openai.ts'
import { createPromptSectionCache } from './prompt/sections.ts'
import { buildMerlionSystemPrompt } from './prompt/system_prompt.ts'
import { readConfig, mergeConfig, type MerlionProvider } from './config/store.ts'
import {
  runConfigWizard,
  DEFAULT_PROVIDER,
  normalizeProvider,
  defaultBaseURLForProvider,
  defaultModelForProvider
} from './config/wizard.ts'
import { loadAgentsGuidance } from './artifacts/agents.ts'
import { ensureGeneratedAgentsMaps } from './artifacts/agents_bootstrap.ts'
import {
  refreshCodebaseIndex,
  updateCodebaseIndexWithChangedFiles
} from './artifacts/codebase_index.ts'
import { updateProgressFromRuntimeSignals } from './artifacts/progress_auto.ts'
import { detectPotentialStaleGuidance } from './artifacts/guidance_staleness.ts'
import { buildOrientationContext } from './context/orientation.ts'
import {
  buildPathGuidanceDelta,
  createPathGuidanceState,
  extractCandidatePathsFromToolEvent,
} from './context/path_guidance.ts'
import { runLoop } from './runtime/loop.ts'
import { detectSuccessfulGitCommit, summarizeToolBatchMilestones } from './runtime/tool_batch_milestones.ts'
import { buildIntentContract } from './runtime/intent_contract.ts'
import {
  appendSessionMeta,
  appendTranscriptMessage,
  appendUsage,
  createSessionFiles,
  getSessionFilesForResume,
  loadSessionMessages
} from './runtime/session.ts'
import { calculateUsageCostUsd, createUsageTracker, type UsageRates } from './runtime/usage.ts'
import type { PromptObservabilitySnapshot } from './runtime/prompt_observability.ts'
import { createPromptObservabilityTrackerWithToolSchema } from './runtime/prompt_observability.ts'
import { buildDefaultRegistry } from './tools/builtin/index.ts'
import { discoverVerificationChecks } from './verification/checks.ts'
import { runVerificationFixRounds } from './verification/fix_round.ts'
import { runVerificationChecks } from './verification/runner.ts'

interface CliFlags {
  /** CLI-only flag overrides (undefined = not specified on CLI) */
  modelFlag: string | undefined
  baseURLFlag: string | undefined
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
  resumeSessionId?: string
  repl: boolean
  verify: boolean
  configMode: boolean
  wechatMode: boolean
  wechatLogin: boolean
  task: string
}

interface CliOptions {
  task: string
  /** Resolved model (after merging env, config file, CLI flag) */
  model: string
  /** Resolved base URL */
  baseURL: string
  /** Resolved API key */
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

function parseArgs(argv: string[]): CliFlags | null | 'help' | 'version' {
  const args = [...argv]
  let modelFlag: string | undefined
  let baseURLFlag: string | undefined
  let cwd = currentCwd()
  let permissionMode: CliFlags['permissionMode'] = 'interactive'
  let resumeSessionId: string | undefined
  let repl = false
  let verify = process.env.MERLION_VERIFY === '1'
  let configMode = false
  let wechatMode = false
  let wechatLogin = false
  const taskParts: string[] = []

  while (args.length > 0) {
    const arg = args.shift()!
    if (arg === '--model') {
      modelFlag = args.shift()
      continue
    }
    if (arg === '--base-url') {
      baseURLFlag = args.shift()
      continue
    }
    if (arg === '--cwd') {
      cwd = args.shift() ?? cwd
      continue
    }
    if (arg === '--auto-allow') {
      permissionMode = 'auto_allow'
      continue
    }
    if (arg === '--auto-deny') {
      permissionMode = 'auto_deny'
      continue
    }
    if (arg === '--resume') {
      resumeSessionId = args.shift()
      continue
    }
    if (arg === '--repl') {
      repl = true
      continue
    }
    if (arg === '--verify') {
      verify = true
      continue
    }
    if (arg === '--no-verify') {
      verify = false
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return 'help'
    }
    if (arg === '--config' || arg === 'config') {
      configMode = true
      continue
    }
    if (arg === 'wechat' || arg === 'connect') {
      wechatMode = true
      continue
    }
    if (arg === '--login') {
      wechatLogin = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      return 'version'
    }
    taskParts.push(arg)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0 && !resumeSessionId && !repl && !configMode && !wechatMode) return null

  return {
    task: task.length === 0 ? 'Continue from the existing session state.' : task,
    modelFlag,
    baseURLFlag,
    cwd,
    permissionMode,
    resumeSessionId,
    repl,
    verify,
    configMode,
    wechatMode,
    wechatLogin,
  }
}

function printUsage(): void {
  process.stdout.write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--auto-allow|--auto-deny] [--resume <id>] [--repl] [--verify|--no-verify] [config] [wechat [--login]] "<task>"\n'
  )
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

function inferProviderFromEnv(): MerlionProvider | undefined {
  const explicit = normalizeProvider(process.env.MERLION_PROVIDER)
  if (explicit) return explicit
  const hasOpenRouterKey = typeof process.env.OPENROUTER_API_KEY === 'string' && process.env.OPENROUTER_API_KEY.trim() !== ''
  const hasOpenAIKey = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim() !== ''
  if (hasOpenRouterKey) return 'openrouter'
  if (hasOpenAIKey) return 'openai'
  return undefined
}

function envConfigOverrides(flags: { modelFlag?: string; baseURLFlag?: string }): Partial<{
  provider: MerlionProvider
  apiKey: string
  model: string
  baseURL: string
}> {
  const provider = inferProviderFromEnv()
  const apiKey =
    process.env.MERLION_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.OPENAI_API_KEY

  return {
    provider,
    apiKey,
    model: flags.modelFlag ?? process.env.MERLION_MODEL,
    baseURL: flags.baseURLFlag ?? process.env.MERLION_BASE_URL
  }
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

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  if (flags === 'version') {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version: string }
    process.stdout.write(`${pkg.version}\n`)
    return
  }
  if (flags === 'help') {
    printUsage()
    return
  }
  // No arguments → default to interactive REPL mode.
  const resolvedFlags = flags ?? {
    task: '',
    modelFlag: undefined,
    baseURLFlag: undefined,
    cwd: currentCwd(),
    permissionMode: 'interactive' as const,
    resumeSessionId: undefined,
    repl: true,
    verify: process.env.MERLION_VERIFY === '1',
    configMode: false,
    wechatMode: false,
    wechatLogin: false,
  }

  // --- Config resolution ---
  let fileConfig = await readConfig()

  // `merlion config` → always re-run the wizard
  if (resolvedFlags.configMode) {
    const result = await runConfigWizard(fileConfig, undefined, {
      forceProviderPrompt: true,
      forceBaseURLPrompt: true,
      forceApiKeyPrompt: true
    })
    if (!result.ok) {
      process.exitCode = 1
      return
    }
    // If no task was given alongside `config`, just exit after setup.
    if (resolvedFlags.task === 'Continue from the existing session state.' && !resolvedFlags.resumeSessionId && !resolvedFlags.repl) {
      return
    }
    fileConfig = result.config
  }

  const mergedProviderSeed =
    normalizeProvider(process.env.MERLION_PROVIDER) ??
    normalizeProvider(fileConfig.provider) ??
    DEFAULT_PROVIDER

  const merged = mergeConfig(
    envConfigOverrides({ modelFlag: resolvedFlags.modelFlag, baseURLFlag: resolvedFlags.baseURLFlag }),
    fileConfig,
    {
      provider: mergedProviderSeed,
      apiKey: '',
      model: defaultModelForProvider(mergedProviderSeed),
      baseURL: defaultBaseURLForProvider(mergedProviderSeed)
    }
  )

  // If still missing required fields, run the setup wizard.
  const missingRequiredConfig =
    merged.apiKey === '' ||
    merged.model === '' ||
    (merged.provider === 'custom' && merged.baseURL === '')

  if (missingRequiredConfig) {
    const result = await runConfigWizard({
      provider: merged.provider,
      apiKey: merged.apiKey,
      model: merged.model,
      baseURL: merged.baseURL
    })
    if (!result.ok) {
      process.exitCode = 1
      return
    }
    merged.provider = result.config.provider ?? merged.provider
    merged.apiKey = result.config.apiKey ?? ''
    merged.model = result.config.model ?? merged.model
    merged.baseURL = result.config.baseURL ?? merged.baseURL
  }

  // ── WeChat transport mode ─────────────────────────────────────────────────
  if (resolvedFlags.wechatMode) {
    const { runWeixinMode } = await import('./transport/wechat/run.ts')
    await runWeixinMode({
      model: merged.model,
      baseURL: merged.baseURL,
      apiKey: merged.apiKey,
      cwd: resolvedFlags.cwd,
      forceLogin: resolvedFlags.wechatLogin,
      permissionMode: resolvedFlags.permissionMode,
    })
    return
  }

  const options: CliOptions = {
    task: resolvedFlags.task,
    model: merged.model,
    baseURL: merged.baseURL,
    apiKey: merged.apiKey,
    cwd: resolvedFlags.cwd,
    permissionMode: resolvedFlags.permissionMode,
    resumeSessionId: resolvedFlags.resumeSessionId,
    repl: resolvedFlags.repl,
    verify: resolvedFlags.verify
  }

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
  const ui = new CliExperience({
    model: options.model,
    sessionId: session.sessionId,
    isRepl: options.repl
  })

  ui.renderBanner()
  if (startupMapSummary) {
    ui.onMapUpdated(startupMapSummary)
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
      provider: merged.provider,
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

    if (result.config.provider) merged.provider = result.config.provider
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
    const intentContract = buildIntentContract(prompt)
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
        ui.onUsage(snapshot, estimatedCost, usage.provider, latestPromptObservability)
      },
      onPromptObservability: (snapshot) => {
        latestPromptObservability = snapshot
      },
      promptObservabilityTracker,
      onTurnStart: ({ turn }) => {
        ui.onTurnStart({ turn })
      },
      onAssistantResponse: ({ turn, finish_reason, tool_calls_count }) => {
        ui.onAssistantResponse({ turn, finish_reason, tool_calls_count })
      },
      onToolCallStart: ({ call, index, total }) => {
        ui.onToolStart({
          index,
          total,
          name: call.function.name,
          summary: call.function.arguments
        })
      },
      onToolCallResult: async ({ call, index, total, durationMs, isError, uiPayload, message }) => {
        ui.onToolResult({
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
          ui.onPhaseUpdate(line)
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
        ui.onMapUpdated(
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
        ui.onMapUpdated(
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
        ui.onPhaseUpdate('阶段更新：progress 快照已同步到 .merlion/progress.md。')
      }
    } catch (error) {
      process.stderr.write(`Progress auto-update warning: ${String(error)}\n`)
    }

    if (changedFiles.size > 0) {
      try {
        const staleHints = await detectPotentialStaleGuidance(options.cwd, [...changedFiles])
        if (staleHints.length > 0) {
          const preview = staleHints.map((hint) => hint.guidanceFile).join(', ')
          ui.onMapUpdated(`guidance may be stale after code changes: ${preview}`)
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
          ui.onMapUpdated(
            `generated project map refreshed (${refreshed.generatedFiles.length} scope${refreshed.generatedFiles.length === 1 ? '' : 's'})`
          )
        } else if (sawSuccessfulGitCommit) {
          ui.onMapUpdated('generated project map checked (up to date)')
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
      promptLabel: ui.promptLabel(),
      startupMessage: false,
      onPromptSubmitted: (prompt) => {
        ui.clearTypedInputLine()
        ui.renderUserPrompt(prompt)
      },
      onTurnResult: async (result) => {
        ui.renderAssistantOutput(result.output, result.terminal)
        if (!isAuthFailureResult(result)) return
        ui.stopSpinner()
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
        ui.setToolDetailMode(mode)
      },
      onWechatLogin: async () => {
        ui.stopSpinner()
        process.stdout.write(
          '[wechat] Starting WeChat login + listen mode. Press Ctrl+C to return to REPL.\n'
        )
        const { runWeixinMode } = await import('./transport/wechat/run.ts')
        await runWeixinMode({
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
    ui.stopSpinner()
    return
  }

  ui.renderUserPrompt(options.task)
  let result = await runTurn(options.task)
  ui.renderAssistantOutput(result.finalText, result.terminal)
  if (isAuthFailureResult({ output: result.finalText, terminal: result.terminal })) {
    ui.stopSpinner()
    const answer = (await askLine('Provider auth failed. Re-run setup wizard now? [y/N]: ')) ?? ''
    if (/^(y|yes)$/i.test(answer.trim())) {
      const ok = await applyWizardConfig()
      if (ok) {
        process.stdout.write('[config] Updated. Retrying your request once...\n')
        result = await runTurn(options.task)
        ui.renderAssistantOutput(result.finalText, result.terminal)
      } else {
        process.stdout.write('[config] Setup aborted. You can run `merlion config` later.\n')
      }
    } else {
      process.stdout.write('Tip: run `merlion config` any time to update your key/provider/model.\n')
    }
  }
  if (result.terminal !== 'completed') {
    process.stderr.write(`Terminal state: ${result.terminal}\n`)
    process.exitCode = 1
    return
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
          ui.renderUserPrompt(`[verification round ${round}] ${prompt}`)
          const fixResult = await runTurn(prompt)
          ui.renderAssistantOutput(fixResult.finalText, fixResult.terminal)
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
        process.exitCode = 1
      }
    } else {
      process.stdout.write('[verify] no checks discovered\n')
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
