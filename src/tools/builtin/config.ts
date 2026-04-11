import type { ToolDefinition } from '../types.js'
import { readConfig, writeConfig } from '../../config/store.ts'

type SupportedSetting = 'apiKey' | 'model' | 'baseURL'

function normalizeSetting(value: unknown): SupportedSetting | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if (key === 'apikey' || key === 'api_key') return 'apiKey'
  if (key === 'model') return 'model'
  if (key === 'baseurl' || key === 'base_url') return 'baseURL'
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
      return { content: 'Unknown setting. Allowed: apiKey, model, baseURL.', isError: true }
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
    await writeConfig({ ...config, [setting]: nextValue })
    return { content: `Set ${setting}=${nextValue}`, isError: false }
  }
}
