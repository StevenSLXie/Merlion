import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type MerlionProvider = 'openrouter' | 'openai' | 'custom'

export interface MerlionConfig {
  provider?: MerlionProvider
  apiKey?: string
  model?: string
  baseURL?: string
}

/** Returns the directory that holds the config file, honoring XDG_CONFIG_HOME. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config')
  return join(base, 'merlion')
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

/**
 * Reads the saved config file.  Returns an empty object when the file does not
 * exist or cannot be parsed.
 */
export async function readConfig(): Promise<MerlionConfig> {
  const file = configPath()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return {}
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as MerlionConfig
  } catch {
    return {}
  }
}

/**
 * Writes the config file, creating the directory if needed.
 * Sets file permissions to 0o600 (owner read/write only) on POSIX.
 */
export async function writeConfig(config: MerlionConfig): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  const file = configPath()
  const json = JSON.stringify(config, null, 2) + '\n'
  await writeFile(file, json, { mode: 0o600, encoding: 'utf8' })
}

/**
 * Merges config sources in priority order (highest first):
 *   overrides (CLI flags / env vars)  >  file config  >  defaults
 *
 * Each field is taken from the highest-priority source that supplies a
 * non-empty string value.
 */
export function mergeConfig(
  overrides: Partial<MerlionConfig>,
  fileConfig: MerlionConfig,
  defaults: { provider: MerlionProvider; apiKey: string; model: string; baseURL: string }
): Required<MerlionConfig> {
  return {
    provider: firstNonEmpty(overrides.provider, fileConfig.provider, defaults.provider) as MerlionProvider,
    apiKey: firstNonEmpty(overrides.apiKey, fileConfig.apiKey, defaults.apiKey),
    model: firstNonEmpty(overrides.model, fileConfig.model, defaults.model),
    baseURL: firstNonEmpty(overrides.baseURL, fileConfig.baseURL, defaults.baseURL)
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
