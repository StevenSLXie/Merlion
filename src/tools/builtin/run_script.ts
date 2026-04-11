import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'
import { runProcess } from './process_common.ts'

function isSafeScriptName(name: string): boolean {
  return /^[A-Za-z0-9:_-]+$/.test(name)
}

export const runScriptTool: ToolDefinition = {
  name: 'run_script',
  description: 'Run an npm script by name.',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string' },
      timeout_ms: { type: 'integer' }
    },
    required: ['script']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const script = input.script
    if (typeof script !== 'string' || script.trim() === '') {
      return { content: 'Invalid script name: expected non-empty string.', isError: true }
    }
    if (!isSafeScriptName(script)) {
      return { content: 'Invalid script name: only [A-Za-z0-9:_-] is allowed.', isError: true }
    }
    const timeoutMs = parsePositiveInt(input.timeout_ms, 120_000, 1_000, 600_000)
    const decision = await ctx.permissions?.ask('run_script', `npm run ${script}`)
    if (decision === 'deny' || decision === undefined) {
      return { content: '[Permission denied]', isError: true }
    }

    const result = await runProcess('npm', ['run', script], ctx.cwd, { timeoutMs })
    if (result.timedOut) {
      return {
        content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\n[script timed out after ${timeoutMs} ms]`,
        isError: true
      }
    }
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter((v) => v !== '')
      .join('\n')
    const content = output === '' ? `[exit: ${result.exitCode}]` : `${output}\n[exit: ${result.exitCode}]`
    return { content, isError: result.exitCode !== 0 }
  }
}
