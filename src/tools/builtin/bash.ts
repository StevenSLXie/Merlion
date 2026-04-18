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
    let exitCode: number | null = null

    const settle = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(killTimer)
      resolve({ content: combined, exit: code, timedOut })
    }

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
    child.on('exit', (code) => {
      exitCode = code
      settle(code ?? -1)
    })
    // Fallback for environments where only `close` arrives.
    child.on('close', (code) => {
      settle(code ?? exitCode ?? -1)
    })
    child.on('error', (error) => {
      combined += String(error)
      settle(-1)
    })
  })
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command. Avoid interactive commands.',
  modelGuidance: [
    '- Use bash for tests, scripts, build steps, git inspection, or environment checks.',
    '- Prefer read_file for reading files and prefer grep/search/glob/list_dir for repo navigation.',
    '- command must be a raw shell command only; do not include shell prompts, prose, or transcript labels.',
    '- Avoid interactive commands and avoid using bash when a dedicated file/search tool is more precise.'
  ].join('\n'),
  modelExamples: [
    '{"command":"npm test -- --runInBand","timeout":120000}'
  ],
  guidancePriority: 'critical',
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
