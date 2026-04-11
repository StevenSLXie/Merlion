import { cwd as currentCwd } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { CliExperience } from './cli/experience.ts'
import { runReplSession } from './cli/repl.ts'
import { createPermissionStore } from './permissions/store.ts'
import { OpenAICompatProvider } from './providers/openai.ts'
import { ensureCodebaseIndex, updateCodebaseIndexWithChangedFiles } from './artifacts/codebase_index.ts'
import { buildOrientationContext } from './context/orientation.ts'
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
import { buildDefaultRegistry } from './tools/builtin/index.ts'

interface CliOptions {
  task: string
  model: string
  baseURL: string
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
  resumeSessionId?: string
  repl: boolean
}

function parseArgs(argv: string[]): CliOptions | null | 'help' {
  const args = [...argv]
  let model = process.env.MERLION_MODEL ?? 'anthropic/claude-sonnet-4-5'
  let baseURL = process.env.MERLION_BASE_URL ?? 'https://openrouter.ai/api/v1'
  let cwd = currentCwd()
  let permissionMode: CliOptions['permissionMode'] = 'interactive'
  let resumeSessionId: string | undefined
  let repl = false
  const taskParts: string[] = []

  while (args.length > 0) {
    const arg = args.shift()!
    if (arg === '--model') {
      model = args.shift() ?? model
      continue
    }
    if (arg === '--base-url') {
      baseURL = args.shift() ?? baseURL
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
    if (arg === '--help' || arg === '-h') {
      return 'help'
    }
    taskParts.push(arg)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0 && !resumeSessionId && !repl) return null
  return {
    task: task.length === 0 ? 'Continue from the existing session state.' : task,
    model,
    baseURL,
    cwd,
    permissionMode,
    resumeSessionId,
    repl
  }
}

function printUsage(): void {
  process.stdout.write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--auto-allow|--auto-deny] [--resume <id>] [--repl] "<task>"\n'
  )
}

function estimateToolSchemaTokens(registry: ReturnType<typeof buildDefaultRegistry>): number {
  const serialized = JSON.stringify(registry.getAll().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })))
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
  const options = parseArgs(process.argv.slice(2))
  if (options === 'help') {
    printUsage()
    return
  }
  if (!options) {
    printUsage()
    process.exitCode = 1
    return
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    process.stderr.write('OPENROUTER_API_KEY is required.\n')
    process.exitCode = 1
    return
  }

  const provider = new OpenAICompatProvider({
    apiKey,
    baseURL: options.baseURL,
    model: options.model
  })
  const registry = buildDefaultRegistry()
  const permissions = createPermissionStore(options.permissionMode)
  const session = options.resumeSessionId
    ? await getSessionFilesForResume(options.cwd, options.resumeSessionId)
    : await createSessionFiles(options.cwd)
  if (!options.resumeSessionId) {
    await appendSessionMeta(session.transcriptPath, session.sessionId, options.model, options.cwd)
  }
  const toolSchemaTokensEstimate = estimateToolSchemaTokens(registry)
  const initialMessagesFromResume = options.resumeSessionId
    ? await loadSessionMessages(session.transcriptPath)
    : undefined
  const initialMessages = initialMessagesFromResume ?? [
    { role: 'system' as const, content: 'You are Merlion, a coding agent. Use tools to complete the task.' }
  ]
  if (!options.resumeSessionId && initialMessages.length > 0) {
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

  const systemPrompt = 'You are Merlion, a coding agent. Use tools to complete the task.'
  let history = initialMessages
  const usageTracker = createUsageTracker()
  const usageRates = loadUsageRatesFromEnv()
  const ui = new CliExperience({
    model: options.model,
    sessionId: session.sessionId,
    isRepl: options.repl
  })

  ui.renderBanner()

  const runTurn = async (prompt: string) => {
    const changedFiles = new Set<string>()
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
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cached_tokens: usage.cached_tokens ?? null,
          tool_schema_tokens_estimate: toolSchemaTokensEstimate
        })
        const snapshot = usageTracker.record(usage)
        const estimatedCost = usageRates ? calculateUsageCostUsd(snapshot.totals, usageRates) : undefined
        ui.onUsage(snapshot, estimatedCost)
      },
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
      onToolCallResult: ({ call, index, total, durationMs, isError }) => {
        ui.onToolResult({
          index,
          total,
          name: call.function.name,
          isError,
          durationMs
        })
        if (!isError && (call.function.name === 'create_file' || call.function.name === 'edit_file')) {
          const path = extractPathArg(call.function.arguments)
          if (path) changedFiles.add(path)
        }
      }
    })
    if (changedFiles.size > 0) {
      try {
        await updateCodebaseIndexWithChangedFiles(options.cwd, [...changedFiles])
      } catch (error) {
        process.stderr.write(`Codebase index update warning: ${String(error)}\n`)
      }
    }
    history = result.state.messages
    return result
  }

  if (options.repl) {
    const rl = createInterface({ input, output })
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
      onTurnResult: (result) => {
        ui.renderAssistantOutput(result.output, result.terminal)
      }
    })
    ui.stopSpinner()
    rl.close()
    return
  }

  ui.renderUserPrompt(options.task)
  const result = await runTurn(options.task)
  ui.renderAssistantOutput(result.finalText, result.terminal)
  if (result.terminal !== 'completed') {
    process.stderr.write(`Terminal state: ${result.terminal}\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
