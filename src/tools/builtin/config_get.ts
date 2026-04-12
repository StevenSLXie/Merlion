import type { ToolDefinition } from '../types.js'
import { readConfig } from '../../config/store.ts'

export const configGetTool: ToolDefinition = {
  name: 'config_get',
  description: 'Read Merlion config values from ~/.config/merlion/config.json.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' }
    }
  },
  concurrencySafe: true,
  async execute(input) {
    const config = await readConfig()
    const key = typeof input.key === 'string' ? input.key.trim() : ''
    if (key === '') {
      return { content: JSON.stringify(config, null, 2), isError: false }
    }
    if (key !== 'provider' && key !== 'apiKey' && key !== 'model' && key !== 'baseURL') {
      return { content: 'Invalid key. Allowed: provider, apiKey, model, baseURL.', isError: true }
    }
    const value = config[key]
    return { content: value ? `${key}=${value}` : `${key} is not set`, isError: false }
  }
}
