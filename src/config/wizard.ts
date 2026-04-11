import { createInterface } from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { writeConfig, configPath, type MerlionConfig } from './store.ts'

export const DEFAULT_MODEL = 'google/gemini-2.5-flash-preview'
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

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
      // Mute stdout while the user types so the key is not echoed.
      const rl = createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      })
      stdout.write(question)
      // Suppress echoing by overriding _writeToOutput.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(rl as any)._writeToOutput = () => {}
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
  io.write('  No API key found. Let\'s get you configured.\n')
  io.write('\n')

  // --- API key ---
  let apiKey: string
  if (existingConfig.apiKey && existingConfig.apiKey.trim() !== '') {
    apiKey = existingConfig.apiKey
    io.write('  OpenRouter API key: (using existing value)\n')
  } else {
    const raw = await io.promptSecret('  OpenRouter API key: ')
    if (raw.trim() === '') {
      io.write('\n  Setup aborted. Set OPENROUTER_API_KEY or re-run `merlion config`.\n\n')
      return { ok: false, config: {} }
    }
    apiKey = raw.trim()
  }

  // --- Model ---
  const modelDefault = existingConfig.model?.trim() || DEFAULT_MODEL
  const modelAnswer = await io.prompt(`  Model [${modelDefault}]: `)
  const model = modelAnswer.trim() === '' ? modelDefault : modelAnswer.trim()

  // --- Base URL (not prompted — use default silently) ---
  const baseURL = existingConfig.baseURL?.trim() || DEFAULT_BASE_URL

  const config: MerlionConfig = { apiKey, model, baseURL }
  await writeConfig(config)

  io.write('\n')
  io.write(`  Config saved to ${configPath()}\n`)
  io.write('  Run `merlion config` at any time to update settings.\n')
  io.write('\n')

  return { ok: true, config }
}
