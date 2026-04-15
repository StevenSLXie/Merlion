import { execSync } from 'node:child_process'

import { askLine } from '../cli/ask.ts'
import { getSystemSlashCommands } from '../cli/commands.ts'
import { readReplInputLine } from '../cli/input_buffer.ts'
import { runReplSession } from '../cli/repl.ts'
import { createPermissionStore } from '../permissions/store.ts'
import { OpenAICompatProvider } from '../providers/openai.ts'
import { createPromptObservabilityTrackerWithToolSchema } from './prompt_observability.ts'
import { buildIntentContract } from './intent_contract.ts'
import {
  appendSessionMeta,
  appendTranscriptMessage,
  appendUsage,
  createSessionFiles,
  getSessionFilesForResume,
  loadSessionMessages,
} from './session.ts'
import { calculateUsageCostUsd, createUsageTracker, type UsageRates } from './usage.ts'
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
import { RuntimeTaskRegistry } from './tasks/registry.ts'
import { localTurnTaskHandler } from './tasks/handlers/local_turn.ts'
import { verificationTaskHandler } from './tasks/handlers/verify_round.ts'
import type { LocalTurnTaskInput, LocalTurnTaskOutput, VerificationTaskInput, VerificationTaskOutput } from './tasks/types.ts'

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
  const initialMessagesFromResume = options.resumeSessionId
    ? await loadSessionMessages(session.transcriptPath)
    : undefined
  const usageTracker = createUsageTracker()
  const usageRates = loadUsageRatesFromEnv()
  const sink = new CliRuntimeSink({
    model: options.model,
    sessionId: session.sessionId,
    isRepl: options.repl
  })
  const contextService = createContextService({
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    orientationBudgets: loadOrientationBudgetsFromEnv(),
    pathGuidanceBudgets: loadPathGuidanceBudgetsFromEnv(),
  })

  let engine = new QueryEngine({
    cwd: options.cwd,
    provider,
    registry,
    permissions,
    contextService,
    model: options.model,
    sessionId: session.sessionId,
    initialMessages: options.resumeSessionId ? [] : undefined,
    maxTurns: 100,
    askQuestions: (questions) => askStructuredQuestions(questions, { readLine: askLine }),
    sink,
    promptObservabilityTracker,
    persistMessage: async (message) => {
      await appendTranscriptMessage(session.transcriptPath, message)
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
        prompt_observability: entry.promptObservability,
      })
    },
    usageTracker,
    usageRates,
    toolSchemaTokensEstimate,
    buildIntentContract: (prompt) => buildIntentContract(prompt) ?? undefined,
  })
  if (initialMessagesFromResume) {
    await contextService.prefetchIfSafe()
    await engine.resumeFromTranscript(initialMessagesFromResume)
  }
  const taskRegistry = new RuntimeTaskRegistry()
  taskRegistry.register(localTurnTaskHandler)
  taskRegistry.register(verificationTaskHandler)

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

    provider = new OpenAICompatProvider({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.model
    })
    engine = new QueryEngine({
      cwd: options.cwd,
      provider,
      registry,
      permissions,
      contextService,
      model: options.model,
      sessionId: session.sessionId,
      initialMessages: engine.getMessages(),
      maxTurns: 100,
      askQuestions: (questions) => askStructuredQuestions(questions, { readLine: askLine }),
      sink,
      promptObservabilityTracker,
      persistMessage: async (message) => {
        await appendTranscriptMessage(session.transcriptPath, message)
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
          prompt_observability: entry.promptObservability,
        })
      },
      usageTracker,
      usageRates,
      toolSchemaTokensEstimate,
      buildIntentContract: (prompt) => buildIntentContract(prompt) ?? undefined,
    })
    await engine.resumeFromTranscript(engine.getMessages())
    return true
  }

  const runTurn = async (prompt: string) => {
    const handler = taskRegistry.get<LocalTurnTaskInput, LocalTurnTaskOutput>('local_turn')
    if (!handler) throw new Error('Missing local_turn task handler')
    const taskResult = await handler.run(
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
      { engine },
    )
    return taskResult.loopResult ?? {
      terminal: taskResult.terminal as 'completed' | 'max_turns_exceeded' | 'model_error',
      finalText: taskResult.output,
      state: { messages: engine.getMessages(), turnCount: 0, maxOutputTokensRecoveryCount: 0, hasAttemptedReactiveCompact: false, nudgeCount: 0 },
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
      const verifyHandler = taskRegistry.get<VerificationTaskInput, VerificationTaskOutput>('verify_round')
      if (!verifyHandler) throw new Error('Missing verify_round task handler')
      const outcome = await verifyHandler.run({
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
      }, { engine })

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
