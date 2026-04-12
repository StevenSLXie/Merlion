import { cwd as currentCwd } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { CliExperience } from './cli/experience.ts'
import { runReplSession } from './cli/repl.ts'
import { createPermissionStore } from './permissions/store.ts'
import { OpenAICompatProvider } from './providers/openai.ts'
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
import { ensureCodebaseIndex, updateCodebaseIndexWithChangedFiles } from './artifacts/codebase_index.ts'
import { buildOrientationContext } from './context/orientation.ts'
import {
  buildPathGuidanceDelta,
  createPathGuidanceState,
  extractCandidatePathsFromToolEvent,
} from './context/path_guidance.ts'
import { runLoop } from './runtime/loop.ts'
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
    if (arg === '--version' || arg === '-v') {
      return 'version'
    }
    taskParts.push(arg)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0 && !resumeSessionId && !repl && !configMode) return null

  return {
    task: task.length === 0 ? 'Continue from the existing session state.' : task,
    modelFlag,
    baseURLFlag,
    cwd,
    permissionMode,
    resumeSessionId,
    repl,
    verify,
    configMode
  }
}

function printUsage(): void {
  process.stdout.write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--auto-allow|--auto-deny] [--resume <id>] [--repl] [--verify|--no-verify] [config] "<task>"\n'
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

function extractPathArg(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed.path
    return typeof value === 'string' && value.trim() !== '' ? value : null
  } catch {
    return null
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
    configMode: false
  }

  // --- Config resolution ---
  let fileConfig = await readConfig()

  // `merlion config` → always re-run the wizard
  if (resolvedFlags.configMode) {
    const result = await runConfigWizard(fileConfig)
    if (!result.ok) {
      process.exitCode = 1
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
  if (!options.resumeSessionId && initialMessages.length > 0) {
    try {
      const bootstrap = await ensureGeneratedAgentsMaps(options.cwd)
      if (bootstrap.created) {
        startupMapSummary =
          `initialized generated project map (${bootstrap.generatedFiles.length} scope` +
          `${bootstrap.generatedFiles.length === 1 ? '' : 's'})`
      }
    } catch (error) {
      process.stderr.write(`Agents map bootstrap warning: ${String(error)}\n`)
    }
    await appendTranscriptMessage(session.transcriptPath, initialMessages[0]!)
    try {
      await ensureCodebaseIndex(options.cwd)
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

  const systemPrompt = [
    'You are Merlion, a coding agent. Use tools to complete the task.',
    'Use path-guided exploration:',
    '1) pick 1-3 candidate directories from loaded AGENTS/context before broad search,',
    '2) search/read inside candidates first,',
    '3) widen scope only when evidence is insufficient,',
    '4) when AGENTS guidance conflicts, nearest directory scope wins.'
  ].join(' ')
  let history = initialMessages
  const usageTracker = createUsageTracker()
  const usageRates = loadUsageRatesFromEnv()
  const pathGuidanceBudgets = loadPathGuidanceBudgetsFromEnv()
  const pathGuidanceState = createPathGuidanceState()
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
    let latestPromptObservability: PromptObservabilitySnapshot | undefined
    const result = await runLoop({
      provider,
      registry,
      systemPrompt,
      userPrompt: prompt,
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
        if (!isError && (call.function.name === 'create_file' || call.function.name === 'edit_file')) {
          const path = extractPathArg(call.function.arguments)
          if (path) changedFiles.add(path)
        }
        const candidates = await extractCandidatePathsFromToolEvent(options.cwd, {
          call,
          message
        })
        for (const candidate of candidates) toolPathSignals.add(candidate)
      },
      onToolBatchComplete: async ({ results }) => {
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
    history = result.state.messages
    return result
  }

  if (options.repl) {
    let rl = createInterface({ input, output })
    await runReplSession({
      readLine: async () => {
        try {
          return await rl.question('')
        } catch {
          return null
        }
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
        const answer = await rl.question('Provider auth failed. Re-run setup wizard now? [y/N]: ')
        const yes = /^(y|yes)$/i.test(answer.trim())
        if (!yes) {
          process.stdout.write('Tip: run `merlion config` any time to update your key/provider/model.\n')
          return
        }
        rl.close()
        try {
          const ok = await applyWizardConfig()
          if (ok) {
            process.stdout.write('[config] Updated. Continue in REPL.\n')
          } else {
            process.stdout.write('[config] Setup aborted. Continue in REPL.\n')
          }
        } finally {
          rl = createInterface({ input, output })
        }
      },
      onSetDetailMode: (mode) => {
        ui.setToolDetailMode(mode)
      }
    })
    ui.stopSpinner()
    rl.close()
    return
  }

  ui.renderUserPrompt(options.task)
  let result = await runTurn(options.task)
  ui.renderAssistantOutput(result.finalText, result.terminal)
  if (isAuthFailureResult({ output: result.finalText, terminal: result.terminal })) {
    const rl = createInterface({ input, output })
    let answer = ''
    try {
      answer = await rl.question('Provider auth failed. Re-run setup wizard now? [y/N]: ')
    } finally {
      rl.close()
    }
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
