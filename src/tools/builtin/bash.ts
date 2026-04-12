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

interface NormalizedCommand {
  command: string
  notes: string[]
}

function normalizeCommand(raw: string): NormalizedCommand {
  let rewritten = raw
  const notes: string[] = []

  // Common LLM slip: includes shell prompt marker as part of command text.
  if (/^\s*>>?\s+/.test(rewritten)) {
    rewritten = rewritten.replace(/^\s*>>?\s+/, '')
    notes.push('stripped leading shell prompt marker (`>`/`>>`)')
  }

  const dotGitNormalized = rewritten.replace(/(^|[;&|]\s*)\.git(?=\s+)/g, '$1git')
  if (dotGitNormalized !== rewritten) {
    rewritten = dotGitNormalized
    notes.push('normalized `.git` to `git`')
  }

  return { command: rewritten, notes }
}

function assessCommandRisk(command: string): RiskLevel {
  if (BLOCK_PATTERNS.some((p) => p.test(command))) return 'block'
  if (WARN_PATTERNS.some((p) => p.test(command))) return 'warn'
  return 'safe'
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<{ content: string; exit: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-o', 'pipefail', '-c', command], { cwd })
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
    const normalized = normalizeCommand(command)
    const effectiveCommand = normalized.command

    const timeout = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
      ? Math.min(Math.max(Math.floor(timeoutRaw), 1), 300_000)
      : 30_000

    const risk = assessCommandRisk(effectiveCommand)
    if (risk === 'block') {
      return { content: `[Blocked: command matched high-risk policy] ${effectiveCommand}`, isError: true }
    }
    if (risk === 'warn') {
      const decision = await ctx.permissions?.ask('bash', effectiveCommand)
      if (decision === 'deny' || decision === undefined) {
        return { content: '[Permission denied]', isError: true }
      }
    }

    const result = await runBash(effectiveCommand, ctx.cwd, timeout)
    if (result.timedOut) {
      return {
        content: `${normalized.notes.map((note) => `[autocorrect] ${note}\n`).join('')}${result.content}\n[Command timed out after ${timeout} ms]`,
        isError: true
      }
    }

    const text = result.content.trim().length > 0
      ? `${result.content}\n[exit: ${result.exit}]`
      : `[exit: ${result.exit}]`
    return {
      content: `${normalized.notes.map((note) => `[autocorrect] ${note}\n`).join('')}${text}`,
      isError: result.exit !== 0
    }
  }
}
