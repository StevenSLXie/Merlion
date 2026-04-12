import type { ToolDefinition } from '../types.js'
import type { MerlionProvider } from '../../config/store.ts'
import { readConfig, writeConfig } from '../../config/store.ts'

const ALLOWED_KEYS = new Set(['provider', 'apiKey', 'model', 'baseURL'])

export const configSetTool: ToolDefinition = {
  name: 'config_set',
  description: 'Set Merlion config key in ~/.config/merlion/config.json.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' }
    },
    required: ['key', 'value']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const key = input.key
    const value = input.value
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      return { content: 'Invalid key. Allowed: provider, apiKey, model, baseURL.', isError: true }
    }
    if (typeof value !== 'string') {
      return { content: 'Invalid value: expected string.', isError: true }
    }
    if (key === 'provider') {
      const normalized = value.trim().toLowerCase()
      if (normalized !== 'openrouter' && normalized !== 'openai' && normalized !== 'custom') {
        return { content: 'Invalid provider. Allowed: openrouter, openai, custom.', isError: true }
      }
      const decision = await ctx.permissions?.ask('config_set', `Set config ${key}`)
      if (decision === 'deny' || decision === undefined) {
        return { content: '[Permission denied]', isError: true }
      }
      const config = await readConfig()
      await writeConfig({ ...config, provider: normalized as MerlionProvider })
      return { content: `Set ${key} in config`, isError: false }
    }
    const decision = await ctx.permissions?.ask('config_set', `Set config ${key}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    const config = await readConfig()
    await writeConfig({ ...config, [key]: value })
    return { content: `Set ${key} in config`, isError: false }
  }
}
