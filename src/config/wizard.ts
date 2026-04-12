import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { writeConfig, configPath, type MerlionConfig, type MerlionProvider } from './store.ts'

export const DEFAULT_PROVIDER: MerlionProvider = 'openrouter'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'qwen/qwen3-coder'
export const DEFAULT_BASE_URL = OPENROUTER_BASE_URL

export interface WizardIO {
  /** Prompt the user and return their answer (without the trailing newline). */
  prompt(question: string): Promise<string>
  /** Like prompt but input is not echoed (for secrets). */
  promptSecret(question: string): Promise<string>
  write(text: string): void
}

/** Default IO implementation backed by real stdin/stdout. */
export function createStdioWizardIO(): WizardIO {
  return {
    async prompt(question: string): Promise<string> {
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },

    async promptSecret(question: string): Promise<string> {
      // Route readline's output to a sink so typed characters are never echoed.
      // Writing the question directly to stdout keeps it visible.
      const sink = new Writable({ write(_chunk, _enc, cb) { cb() } })
      const rl = createInterface({ input: stdin, output: sink, terminal: stdin.isTTY })
      stdout.write(question)
      try {
        const answer = await rl.question('')
        stdout.write('\n')
        return answer
      } finally {
        rl.close()
      }
    },

    write(text: string): void {
      stdout.write(text)
    }
  }
}

export interface WizardResult {
  /** true → config was filled in and saved; false → user aborted */
  ok: boolean
  config: MerlionConfig
}

function parseProvider(value: string): MerlionProvider | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === '1' || normalized === 'openrouter' || normalized === 'or') {
    return 'openrouter'
  }
  if (normalized === '2' || normalized === 'openai' || normalized === 'oa') {
    return 'openai'
  }
  if (normalized === '3' || normalized === 'custom' || normalized === 'other' || normalized === 'compatible') {
    return 'custom'
  }
  return null
}

function normalizeProvider(value: unknown): MerlionProvider | null {
  if (typeof value !== 'string') return null
  return parseProvider(value)
}

function defaultBaseURLForProvider(provider: MerlionProvider): string {
  if (provider === 'openai') return OPENAI_BASE_URL
  if (provider === 'openrouter') return OPENROUTER_BASE_URL
  return ''
}

function defaultModelForProvider(provider: MerlionProvider): string {
  if (provider === 'openai') return 'gpt-4.1-mini'
  return DEFAULT_MODEL
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Runs the interactive first-run setup wizard.
 *
 * @param existingConfig  Values already known (e.g. partially set env vars).
 *                        Fields present here are shown as pre-filled defaults
 *                        and skip the corresponding prompt.
 * @param io              Abstracted IO — real stdio in production, fake in tests.
 */
export async function runConfigWizard(
  existingConfig: MerlionConfig = {},
  io: WizardIO = createStdioWizardIO()
): Promise<WizardResult> {
  io.write('\n')
  io.write('  Merlion Setup\n')
  io.write('  ─────────────────────────────────────────────────\n')
  io.write('  Let\'s get you configured.\n')
  io.write('\n')

  // --- Provider ---
  let provider: MerlionProvider
  const existingProvider = normalizeProvider(existingConfig.provider)
  if (existingProvider) {
    provider = existingProvider
    io.write(`  Provider: ${provider} (using existing value)\n`)
  } else {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await io.prompt('  Provider [1=openrouter, 2=openai, 3=custom]: ')
      const parsed = parseProvider(answer)
      if (parsed) {
        provider = parsed
        break
      }
      io.write('  Invalid provider. Choose 1, 2, or 3.\n')
    }
  }

  // --- Base URL ---
  let baseURL: string
  if (provider === 'openrouter') {
    baseURL = existingConfig.baseURL?.trim() || OPENROUTER_BASE_URL
    io.write(`  Base URL: ${baseURL}\n`)
  } else if (provider === 'openai') {
    baseURL = existingConfig.baseURL?.trim() || OPENAI_BASE_URL
    io.write(`  Base URL: ${baseURL}\n`)
  } else {
    const existingBaseURL = existingConfig.baseURL?.trim()
    if (existingBaseURL && isHttpUrl(existingBaseURL)) {
      baseURL = existingBaseURL
      io.write(`  Base URL: ${baseURL} (using existing value)\n`)
    } else {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const answer = await io.prompt('  Custom base URL (OpenAI-compatible endpoint): ')
        const trimmed = answer.trim()
        if (trimmed === '') {
          io.write('\n  Setup aborted. Base URL is required for custom provider.\n\n')
          return { ok: false, config: {} }
        }
        if (!isHttpUrl(trimmed)) {
          io.write('  Invalid URL. Use http:// or https://\n')
          continue
        }
        baseURL = trimmed
        break
      }
    }
  }

  // --- API key ---
  let apiKey: string
  if (existingConfig.apiKey && existingConfig.apiKey.trim() !== '') {
    apiKey = existingConfig.apiKey
    io.write('  API key: (using existing value)\n')
  } else {
    const raw = await io.promptSecret('  API key: ')
    if (raw.trim() === '') {
      io.write('\n  Setup aborted. Set MERLION_API_KEY (or provider-specific key) or re-run `merlion config`.\n\n')
      return { ok: false, config: {} }
    }
    apiKey = raw.trim()
  }

  // --- Model ---
  const modelDefault = existingConfig.model?.trim() || defaultModelForProvider(provider)
  const modelAnswer = await io.prompt(`  Model [${modelDefault}]: `)
  const model = modelAnswer.trim() === '' ? modelDefault : modelAnswer.trim()

  const config: MerlionConfig = { provider, apiKey, model, baseURL }
  await writeConfig(config)

  io.write('\n')
  io.write(`  Config saved to ${configPath()}\n`)
  io.write('  Run `merlion config` at any time to update settings.\n')
  io.write('\n')

  return { ok: true, config }
}
