import type { ToolDefinition } from '../types.js'
import type { MerlionProvider } from '../../config/store.ts'
import { readConfig, writeConfig } from '../../config/store.ts'

type SupportedSetting = 'provider' | 'model'

function normalizeSetting(value: unknown): SupportedSetting | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if (key === 'provider') return 'provider'
  if (key === 'model') return 'model'
  return null
}

export const configTool: ToolDefinition = {
  name: 'config',
  description: 'Get or set Merlion config values.',
  parameters: {
    type: 'object',
    properties: {
      setting: { type: 'string' },
      value: { type: ['string', 'number', 'boolean'] }
    },
    required: ['setting']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const setting = normalizeSetting(input.setting)
    if (!setting) {
      return { content: 'Unknown setting. Allowed: provider, model.', isError: true }
    }

    const config = await readConfig()
    if (input.value === undefined) {
      const current = config[setting]
      return { content: current ? `${setting}=${current}` : `${setting} is not set`, isError: false }
    }

    const decision = await ctx.permissions?.ask('config', `Set ${setting}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    if (typeof input.value === 'string' && input.value.trim().toLowerCase() === 'default') {
      const next = { ...config }
      delete next[setting]
      await writeConfig(next)
      return { content: `Reset ${setting} to default`, isError: false }
    }

    const nextValue = String(input.value)
    if (setting === 'provider') {
      const normalized = nextValue.trim().toLowerCase()
      if (normalized !== 'openrouter' && normalized !== 'openai' && normalized !== 'custom') {
        return { content: 'Invalid provider. Allowed: openrouter, openai, custom.', isError: true }
      }
      await writeConfig({ ...config, provider: normalized as MerlionProvider })
      return { content: `Set ${setting}=${normalized}`, isError: false }
    }
    await writeConfig({ ...config, [setting]: nextValue })
    return { content: `Set ${setting}=${nextValue}`, isError: false }
  }
}
