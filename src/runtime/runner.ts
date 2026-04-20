import { askLine } from '../cli/ask.ts'
import { getSystemSlashCommands } from '../cli/commands.ts'
import { readReplInputLine } from '../cli/input_buffer.ts'
import { runReplSession } from '../cli/repl.ts'
import { createPermissionStore } from '../permissions/store.ts'
import { OpenAICompatProvider } from '../providers/openai.ts'
import { OpenAIResponsesProvider } from '../providers/openai_responses.ts'
import { createPromptObservabilityTrackerWithToolSchema } from './prompt_observability.ts'
import { buildIntentContract } from './intent_contract.ts'
import {
  appendTranscriptItem,
  appendTranscriptResponse,
  appendSessionMeta,
  appendUsage,
  createSessionFiles,
  getSessionFilesForResume,
  loadSessionTranscript,
} from './session.ts'
import { createUsageTracker, type UsageRates } from './usage.ts'
import { createContextService } from '../context/service.ts'
import { buildDefaultRegistry } from '../tools/builtin/index.ts'
import { bashTool } from '../tools/builtin/bash.ts'
import { discoverVerificationChecks } from '../verification/checks.ts'
import { runVerificationChecks } from '../verification/runner.ts'
import { runConfigWizard } from '../config/wizard.ts'
import type { MerlionProvider } from '../config/store.ts'
import { CliRuntimeSink } from './sinks/cli.ts'
import { launchWeixinSinkMode } from './sinks/wechat.ts'
import { askStructuredQuestions } from './ask_user_question.ts'
import { QueryEngine } from './query_engine.ts'
import { executeLocalTurn } from './local_turn.ts'
import { executeVerificationRound } from './verify_round.ts'
import { createSubagentRuntime as createChildSubagentRuntime } from './subagents.ts'

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

export async function runCliRuntime(options: CliRuntimeOptions): Promise<number> {
  const createProvider = () => {
    if (options.provider === 'openai') {
      return new OpenAIResponsesProvider({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        model: options.model
      })
    }
    return new OpenAICompatProvider({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.model
    })
  }
  let provider = createProvider()
  const registry = buildDefaultRegistry({ mode: 'default' })
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
  const initialTranscriptFromResume = options.resumeSessionId
    ? await loadSessionTranscript(session.transcriptPath)
    : undefined
  const usageTracker = createUsageTracker()
  const usageRates = loadUsageRatesFromEnv()
  const sink = new CliRuntimeSink({
    model: options.model,
    sessionId: session.sessionId,
    isRepl: options.repl
  })
  const createContextServiceForRuntime = () => createContextService({
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    orientationBudgets: loadOrientationBudgetsFromEnv(),
    pathGuidanceBudgets: loadPathGuidanceBudgetsFromEnv(),
  })
  const contextService = createContextServiceForRuntime()

  const createEngine = (initialItems?: ReturnType<QueryEngine['getItems']>) => new QueryEngine({
    cwd: options.cwd,
    provider,
    registry,
    permissions,
    contextService,
    model: options.model,
    sessionId: session.sessionId,
    initialItems,
    maxTurns: 100,
    askQuestions: (questions) => askStructuredQuestions(questions, { readLine: askLine }),
    sink,
    promptObservabilityTracker,
    persistItem: async (item, origin, runtimeResponseId) => {
      await appendTranscriptItem(session.transcriptPath, item, origin, runtimeResponseId)
    },
    persistResponseBoundary: async (boundary) => {
      await appendTranscriptResponse(session.transcriptPath, boundary)
    },
    persistUsage: async (entry) => {
      await appendUsage(session.usagePath, {
        timestamp: new Date().toISOString(),
        session_id: session.sessionId,
        model: options.model,
        provider: entry.provider,
        prompt_tokens: entry.prompt_tokens,
        completion_tokens: entry.completion_tokens,
        cached_tokens: entry.cached_tokens ?? null,
        tool_schema_tokens_estimate: toolSchemaTokensEstimate,
        runtime_response_id: entry.runtimeResponseId,
        provider_response_id: entry.providerResponseId,
        provider_finish_reason: entry.providerFinishReason,
        prompt_observability: entry.promptObservability,
      })
    },
    usageTracker,
    usageRates,
    toolSchemaTokensEstimate,
    buildIntentContract: (prompt) => buildIntentContract(prompt) ?? undefined,
    createSubagentRuntime: ({ prompt, history, runtimeState, depth }) => createChildSubagentRuntime({
      cwd: options.cwd,
      session,
      model: options.model,
      parentRegistry: registry,
      permissions,
      askQuestions: (questions) => askStructuredQuestions(questions, { readLine: askLine }),
      buildIntentContract: (subPrompt) => buildIntentContract(subPrompt) ?? undefined,
      sink,
      runtimeState,
      history,
      prompt,
      depth,
      createProvider,
      createContextService: createContextServiceForRuntime,
    }),
  })

  let engine = createEngine(options.resumeSessionId ? [] : undefined)
  if (initialTranscriptFromResume) {
    await contextService.prefetchIfSafe()
    await engine.resumeFromTranscript(initialTranscriptFromResume.items)
  }

  await engine.initialize()

  sink.renderBanner()
  if (engine.getStartupMapSummary()) {
    sink.onMapUpdated(engine.getStartupMapSummary()!)
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

    provider = createProvider()
    const currentItems = engine.getItems()
    engine = createEngine(currentItems)
    await engine.resumeFromTranscript(currentItems)
    return true
  }

  const runTurn = async (prompt: string) => {
    const taskResult = await executeLocalTurn(
      {
        envelope: { kind: 'prompt', text: prompt.trim() },
        executeSlashCommand: async (name: string) => {
          if (name === 'wechat') {
            await launchWeixinSinkMode({
              model: options.model,
              baseURL: options.baseURL,
              apiKey: options.apiKey,
              cwd: options.cwd,
              forceLogin: true,
              permissionMode: options.permissionMode,
            })
            return { output: '[wechat] Listener stopped. Back to runtime.', terminal: 'completed' }
          }
          return { output: `[command] unknown slash command: /${name}`, terminal: 'model_error' }
        },
        executeShellShortcut: async (command: string) => {
          const result = await bashTool.execute({ command }, { cwd: options.cwd, permissions })
          return {
            output: result.content,
            terminal: result.isError ? 'model_error' : 'completed',
          }
        },
      },
      engine,
    )
    return taskResult.loopResult ?? {
      terminal: taskResult.terminal as 'completed' | 'max_turns_exceeded' | 'model_error',
      finalText: taskResult.output,
      state: { items: engine.getItems(), messages: engine.getMessages(), turnCount: 0, maxOutputTokensRecoveryCount: 0, hasAttemptedReactiveCompact: false, nudgeCount: 0 },
    }
  }

  if (options.repl) {
    await runReplSession({
      readLine: async (promptLabel) => {
        return await readReplInputLine({
          promptLabel,
          slashCommands: getSystemSlashCommands(),
        })
      },
      write: (text) => {
        process.stdout.write(text)
      },
      runTurn: async (prompt) => {
        const result = await runTurn(prompt)
        return { output: result.finalText, terminal: result.terminal }
      },
      runShellCommand: async (command) => {
        const result = await bashTool.execute(
          { command },
          { cwd: options.cwd, permissions }
        )
        return {
          output: result.content,
          terminal: result.isError ? 'model_error' : 'completed'
        }
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
      const outcome = await executeVerificationRound({
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
        runFixTurn: async (prompt: string, round: number) => {
          sink.renderUserPrompt(`[verification round ${round}] ${prompt}`)
          const fixResult = await runTurn(prompt)
          sink.renderAssistantOutput(fixResult.finalText, fixResult.terminal)
        },
        onRound: ({ round, action }: { round: number; action: 'fix' | 'pass' | 'stop' }) => {
          if (action === 'fix') {
            process.stdout.write(`[verify] round ${round + 1}: applying automatic fix attempt\n`)
          }
          if (action === 'pass') {
            process.stdout.write('[verify] all checks passed\n')
          }
        },
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
