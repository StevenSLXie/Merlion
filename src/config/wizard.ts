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

export interface RunConfigWizardOptions {
  /** Force provider prompt even when existing provider is available. */
  forceProviderPrompt?: boolean
  /** Force base URL prompt even when existing base URL is available. */
  forceBaseURLPrompt?: boolean
  /** Force API key prompt even when existing key is available. */
  forceApiKeyPrompt?: boolean
  /** When prompting API key, require non-empty input (no keep-existing fallback). */
  requireApiKeyInput?: boolean
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

export function normalizeProvider(value: unknown): MerlionProvider | null {
  if (typeof value !== 'string') return null
  return parseProvider(value)
}

export function defaultBaseURLForProvider(provider: MerlionProvider): string {
  if (provider === 'openai') return OPENAI_BASE_URL
  if (provider === 'openrouter') return OPENROUTER_BASE_URL
  return ''
}

export function defaultModelForProvider(provider: MerlionProvider): string {
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
  io: WizardIO | undefined = createStdioWizardIO(),
  options: RunConfigWizardOptions = {}
): Promise<WizardResult> {
  const ioInstance = io ?? createStdioWizardIO()
  const forceProviderPrompt = options.forceProviderPrompt === true
  const forceBaseURLPrompt = options.forceBaseURLPrompt === true
  const forceApiKeyPrompt = options.forceApiKeyPrompt === true
  const requireApiKeyInput = options.requireApiKeyInput === true

  ioInstance.write('\n')
  ioInstance.write('  Merlion Setup\n')
  ioInstance.write('  ─────────────────────────────────────────────────\n')
  ioInstance.write('  Let\'s get you configured.\n')
  ioInstance.write('\n')

  // --- Provider ---
  let provider: MerlionProvider
  const existingProvider = normalizeProvider(existingConfig.provider)
  if (existingProvider && !forceProviderPrompt) {
    provider = existingProvider
    ioInstance.write(`  Provider: ${provider} (using existing value)\n`)
  } else {
    const providerDefault = existingProvider ?? DEFAULT_PROVIDER
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await ioInstance.prompt(
        forceProviderPrompt
          ? `  Provider [1=openrouter, 2=openai, 3=custom] (${providerDefault}): `
          : '  Provider [1=openrouter, 2=openai, 3=custom]: '
      )
      if (answer.trim() === '') {
        provider = providerDefault
        break
      }
      const parsed = parseProvider(answer)
      if (parsed) {
        provider = parsed
        break
      }
      ioInstance.write('  Invalid provider. Choose 1, 2, or 3.\n')
    }
  }

  // --- Base URL ---
  let baseURL: string
  if (provider === 'openrouter') {
    const defaultBaseURL = existingConfig.baseURL?.trim() || OPENROUTER_BASE_URL
    if (!forceBaseURLPrompt) {
      baseURL = defaultBaseURL
      ioInstance.write(`  Base URL: ${baseURL}\n`)
    } else {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const answer = await ioInstance.prompt(`  Base URL [${defaultBaseURL}]: `)
        const next = answer.trim() === '' ? defaultBaseURL : answer.trim()
        if (!isHttpUrl(next)) {
          ioInstance.write('  Invalid URL. Use http:// or https://\n')
          continue
        }
        baseURL = next
        break
      }
    }
  } else if (provider === 'openai') {
    const defaultBaseURL = existingConfig.baseURL?.trim() || OPENAI_BASE_URL
    if (!forceBaseURLPrompt) {
      baseURL = defaultBaseURL
      ioInstance.write(`  Base URL: ${baseURL}\n`)
    } else {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const answer = await ioInstance.prompt(`  Base URL [${defaultBaseURL}]: `)
        const next = answer.trim() === '' ? defaultBaseURL : answer.trim()
        if (!isHttpUrl(next)) {
          ioInstance.write('  Invalid URL. Use http:// or https://\n')
          continue
        }
        baseURL = next
        break
      }
    }
  } else {
    const existingBaseURL = existingConfig.baseURL?.trim()
    if (existingBaseURL && isHttpUrl(existingBaseURL) && !forceBaseURLPrompt) {
      baseURL = existingBaseURL
      ioInstance.write(`  Base URL: ${baseURL} (using existing value)\n`)
    } else {
      const defaultBaseURL = existingBaseURL && isHttpUrl(existingBaseURL) ? existingBaseURL : ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const question =
          defaultBaseURL === ''
            ? '  Custom base URL (OpenAI-compatible endpoint): '
            : `  Custom base URL (OpenAI-compatible endpoint) [${defaultBaseURL}]: `
        const answer = await ioInstance.prompt(question)
        const trimmed = answer.trim() === '' ? defaultBaseURL : answer.trim()
        if (trimmed === '') {
          ioInstance.write('\n  Setup aborted. Base URL is required for custom provider.\n\n')
          return { ok: false, config: {} }
        }
        if (!isHttpUrl(trimmed)) {
          ioInstance.write('  Invalid URL. Use http:// or https://\n')
          continue
        }
        baseURL = trimmed
        break
      }
    }
  }

  // --- API key ---
  let apiKey: string
  const existingApiKey = existingConfig.apiKey?.trim() ?? ''
  if (existingApiKey !== '' && !forceApiKeyPrompt) {
    apiKey = existingApiKey
    ioInstance.write('  API key: (using existing value)\n')
  } else {
    const question =
      existingApiKey !== '' && !requireApiKeyInput
        ? '  API key [press Enter to keep existing]: '
        : '  API key: '
    const raw = await ioInstance.promptSecret(question)
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (existingApiKey !== '' && !requireApiKeyInput) {
        apiKey = existingApiKey
        ioInstance.write('  API key: (using existing value)\n')
      } else {
        ioInstance.write('\n  Setup aborted. Set MERLION_API_KEY (or provider-specific key) or re-run `merlion config`.\n\n')
        return { ok: false, config: {} }
      }
    } else {
      apiKey = trimmed
    }
  }

  // --- Model ---
  const modelDefault = existingConfig.model?.trim() || defaultModelForProvider(provider)
  const modelAnswer = await ioInstance.prompt(`  Model [${modelDefault}]: `)
  const model = modelAnswer.trim() === '' ? modelDefault : modelAnswer.trim()

  const config: MerlionConfig = { provider, apiKey, model, baseURL }
  await writeConfig(config)

  ioInstance.write('\n')
  ioInstance.write(`  Config saved to ${configPath()}\n`)
  ioInstance.write('  Run `merlion config` at any time to update settings.\n')
  ioInstance.write('\n')

  return { ok: true, config }
}
