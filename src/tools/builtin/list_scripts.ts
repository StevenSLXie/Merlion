import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ToolDefinition } from '../types.js'

export const listScriptsTool: ToolDefinition = {
  name: 'list_scripts',
  description: 'List npm scripts from package.json in workspace root.',
  parameters: {
    type: 'object',
    properties: {}
  },
  concurrencySafe: true,
  async execute(_input, ctx) {
    const packageJsonPath = join(ctx.cwd, 'package.json')
    let raw: string
    try {
      raw = await readFile(packageJsonPath, 'utf8')
    } catch {
      return { content: 'package.json not found in workspace root.', isError: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { content: 'package.json is not valid JSON.', isError: true }
    }
    const scripts = (parsed as { scripts?: Record<string, string> }).scripts
    if (!scripts || Object.keys(scripts).length === 0) {
      return { content: '(no scripts found)', isError: false }
    }
    const lines = Object.entries(scripts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, command]) => `${name}\t${command}`)
    return { content: lines.join('\n'), isError: false }
  }
}
