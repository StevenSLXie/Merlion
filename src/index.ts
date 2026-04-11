import { cwd as currentCwd } from 'node:process'

import { createPermissionStore } from './permissions/store.ts'
import { OpenAICompatProvider } from './providers/openai.ts'
import { runLoop } from './runtime/loop.ts'
import {
  appendSessionMeta,
  appendTranscriptMessage,
  appendUsage,
  createSessionFiles
} from './runtime/session.ts'
import { buildDefaultRegistry } from './tools/builtin/index.ts'

interface CliOptions {
  task: string
  model: string
  baseURL: string
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
}

function parseArgs(argv: string[]): CliOptions | null | 'help' {
  const args = [...argv]
  let model = process.env.MERLION_MODEL ?? 'anthropic/claude-sonnet-4-5'
  let baseURL = process.env.MERLION_BASE_URL ?? 'https://openrouter.ai/api/v1'
  let cwd = currentCwd()
  let permissionMode: CliOptions['permissionMode'] = 'interactive'
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
    if (arg === '--help' || arg === '-h') {
      return 'help'
    }
    taskParts.push(arg)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0) return null
  return { task, model, baseURL, cwd, permissionMode }
}

function printUsage(): void {
  process.stdout.write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--auto-allow|--auto-deny] "<task>"\n'
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
  const session = await createSessionFiles(options.cwd)
  await appendSessionMeta(session.transcriptPath, session.sessionId, options.model, options.cwd)
  const toolSchemaTokensEstimate = estimateToolSchemaTokens(registry)

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'You are Merlion, a coding agent. Use tools to complete the task.',
    userPrompt: options.task,
    cwd: options.cwd,
    maxTurns: 100,
    permissions,
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
        cached_tokens: null,
        tool_schema_tokens_estimate: toolSchemaTokensEstimate
      })
    }
  })

  process.stdout.write(`${result.finalText}\n`)
  if (result.terminal !== 'completed') {
    process.stderr.write(`Terminal state: ${result.terminal}\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
