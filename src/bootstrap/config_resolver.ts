import {
  readConfig,
  mergeConfig,
  type MerlionConfig,
  type MerlionProvider,
} from '../config/store.ts'
import {
  runConfigWizard,
  DEFAULT_PROVIDER,
  normalizeProvider,
  defaultBaseURLForProvider,
  defaultModelForProvider,
} from '../config/wizard.ts'

export interface ConfigResolutionInput {
  modelFlag: string | undefined
  baseURLFlag: string | undefined
  configMode: boolean
  task: string
  resumeSessionId?: string
  repl: boolean
}

export interface ResolvedCliConfig {
  provider: MerlionProvider
  apiKey: string
  model: string
  baseURL: string
}

export type ResolveCliConfigResult =
  | {
      ok: true
      config: ResolvedCliConfig
      shouldExitAfterConfig: boolean
    }
  | {
      ok: false
      exitCode: number
    }

interface ResolveCliConfigDeps {
  readConfigFn?: typeof readConfig
  runConfigWizardFn?: typeof runConfigWizard
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

function envConfigOverrides(flags: { modelFlag?: string; baseURLFlag?: string }): Partial<MerlionConfig> {
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

export async function resolveCliConfig(
  input: ConfigResolutionInput,
  deps?: ResolveCliConfigDeps,
): Promise<ResolveCliConfigResult> {
  const readConfigFn = deps?.readConfigFn ?? readConfig
  const runConfigWizardFn = deps?.runConfigWizardFn ?? runConfigWizard
  let fileConfig = await readConfigFn()

  if (input.configMode) {
    const result = await runConfigWizardFn(fileConfig, undefined, {
      forceProviderPrompt: true,
      forceBaseURLPrompt: true,
      forceApiKeyPrompt: true
    })
    if (!result.ok) {
      return { ok: false, exitCode: 1 }
    }
    if (input.task === 'Continue from the existing session state.' && !input.resumeSessionId && !input.repl) {
      return {
        ok: true,
        config: {
          provider: result.config.provider ?? DEFAULT_PROVIDER,
          apiKey: result.config.apiKey ?? '',
          model: result.config.model ?? defaultModelForProvider(result.config.provider ?? DEFAULT_PROVIDER),
          baseURL: result.config.baseURL ?? defaultBaseURLForProvider(result.config.provider ?? DEFAULT_PROVIDER),
        },
        shouldExitAfterConfig: true,
      }
    }
    fileConfig = result.config
  }

  const mergedProviderSeed =
    normalizeProvider(process.env.MERLION_PROVIDER) ??
    normalizeProvider(fileConfig.provider) ??
    DEFAULT_PROVIDER

  const merged = mergeConfig(
    envConfigOverrides({ modelFlag: input.modelFlag, baseURLFlag: input.baseURLFlag }),
    fileConfig,
    {
      provider: mergedProviderSeed,
      apiKey: '',
      model: defaultModelForProvider(mergedProviderSeed),
      baseURL: defaultBaseURLForProvider(mergedProviderSeed)
    }
  )

  const missingRequiredConfig =
    merged.apiKey === '' ||
    merged.model === '' ||
    (merged.provider === 'custom' && merged.baseURL === '')

  if (missingRequiredConfig) {
    const result = await runConfigWizardFn({
      provider: merged.provider,
      apiKey: merged.apiKey,
      model: merged.model,
      baseURL: merged.baseURL
    })
    if (!result.ok) {
      return { ok: false, exitCode: 1 }
    }
    merged.provider = result.config.provider ?? merged.provider
    merged.apiKey = result.config.apiKey ?? ''
    merged.model = result.config.model ?? merged.model
    merged.baseURL = result.config.baseURL ?? merged.baseURL
  }

  return {
    ok: true,
    config: {
      provider: merged.provider,
      apiKey: merged.apiKey,
      model: merged.model,
      baseURL: merged.baseURL,
    },
    shouldExitAfterConfig: false,
  }
}
