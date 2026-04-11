import { spawn } from 'node:child_process'

import type { ToolDefinition } from '../types.js'

const WARN_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+push\s+--force\b/,
  /DROP\s+TABLE/i,
  /\bTRUNCATE\b/i,
  /\bkubectl\s+delete\b/
]

const BLOCK_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[\/~]/,
  />\s*\/etc\//,
  /curl[^|]*\|\s*(ba)?sh/,
  /wget[^|]*\|\s*(ba)?sh/,
  /`[^`]*rm[^`]*`/,
  /\$\([^)]*rm[^)]*\)/
]

type RiskLevel = 'safe' | 'warn' | 'block'

function assessCommandRisk(command: string): RiskLevel {
  if (BLOCK_PATTERNS.some((p) => p.test(command))) return 'block'
  if (WARN_PATTERNS.some((p) => p.test(command))) return 'warn'
  return 'safe'
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<{ content: string; exit: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd })
    let combined = ''
    let timedOut = false
    let done = false

    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)

    const append = (chunk: unknown) => {
      combined += String(chunk)
      if (combined.length > 100_000) {
        combined = `${combined.slice(0, 100_000)}\n[output truncated]`
      }
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(killTimer)
      resolve({ content: combined, exit: code ?? -1, timedOut })
    })
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(killTimer)
      resolve({ content: String(error), exit: -1, timedOut: false })
    })
  })
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command. Avoid interactive commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'integer' }
    },
    required: ['command']
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const command = input.command
    const timeoutRaw = input.timeout

    if (typeof command !== 'string' || command.trim() === '') {
      return { content: 'Invalid command: expected non-empty string.', isError: true }
    }

    const timeout = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
      ? Math.min(Math.max(Math.floor(timeoutRaw), 1), 300_000)
      : 30_000

    const risk = assessCommandRisk(command)
    if (risk === 'block') {
      return { content: `[Blocked: command matched high-risk policy] ${command}`, isError: true }
    }
    if (risk === 'warn') {
      const decision = await ctx.permissions?.ask('bash', command)
      if (decision === 'deny' || decision === undefined) {
        return { content: '[Permission denied]', isError: true }
      }
    }

    const result = await runBash(command, ctx.cwd, timeout)
    if (result.timedOut) {
      return {
        content: `${result.content}\n[Command timed out after ${timeout} ms]`,
        isError: true
      }
    }

    const text = result.content.trim().length > 0
      ? `${result.content}\n[exit: ${result.exit}]`
      : `[exit: ${result.exit}]`
    return { content: text, isError: result.exit !== 0 }
  }
}

