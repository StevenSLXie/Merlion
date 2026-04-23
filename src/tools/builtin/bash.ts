import type { ToolDefinition } from '../types.js'
import { NoSandboxBackend } from '../../sandbox/no_sandbox.ts'
import { createUnsandboxedPolicy, widenSandboxPolicy } from '../../sandbox/policy.ts'
import { resolveSandboxBackend } from '../../sandbox/resolve.ts'
import type { SandboxViolation } from '../../sandbox/backend.ts'

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

function permissionScope(kind: SandboxViolation['kind'] | 'preflight'): string {
  return `bash:${kind}`
}

function formatBashContent(
  stdout: string,
  stderr: string,
  exitCode: number,
  timedOut: boolean,
  timeout: number,
  notes: string[],
): { content: string; isError: boolean } {
  const combined = [stdout.trim(), stderr.trim()].filter((value) => value !== '').join('\n')
  if (timedOut) {
    return {
      content: `${notes.map((note) => `[autocorrect] ${note}\n`).join('')}${combined}\n[Command timed out after ${timeout} ms]`,
      isError: true,
    }
  }
  const text = combined !== '' ? `${combined}\n[exit: ${exitCode}]` : `[exit: ${exitCode}]`
  return {
    content: `${notes.map((note) => `[autocorrect] ${note}\n`).join('')}${text}`,
    isError: exitCode !== 0,
  }
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

    let policy = ctx.sandbox?.policy ?? createUnsandboxedPolicy(ctx.cwd)
    let backend = ctx.sandbox?.backend ?? new NoSandboxBackend()
    if (!ctx.sandbox) {
      ctx.onSandboxEvent?.({
        type: 'sandbox.warning',
        backend: backend.name(),
        sessionId: ctx.sessionId,
        sandboxMode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        toolName: 'bash',
        summary: `ctx.sandbox missing; running unsandboxed: ${effectiveCommand}`,
      })
    }
    const preapproved = policy.approvalPolicy === 'on-request'
      ? await ctx.permissions?.ask('bash', `Run command: ${effectiveCommand}`, {
        phase: 'preflight',
        sessionScope: permissionScope('preflight'),
      })
      : undefined
    if (preapproved === 'deny') {
      return { content: '[Permission denied]', isError: true }
    }
    if (preapproved === undefined && policy.approvalPolicy === 'on-request') {
      return { content: '[Permission denied]', isError: true }
    }
    if (risk === 'warn' && policy.approvalPolicy !== 'on-request') {
      const decision = await ctx.permissions?.ask('bash', effectiveCommand, {
        phase: 'preflight',
        sessionScope: permissionScope('preflight'),
      })
      if (decision === 'deny' || decision === undefined) {
        return { content: '[Permission denied]', isError: true }
      }
    }

    ctx.onSandboxEvent?.({
      type: 'sandbox.backend.selected',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'bash',
      summary: effectiveCommand,
    })
    ctx.onSandboxEvent?.({
      type: 'sandbox.command.started',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'bash',
      summary: effectiveCommand,
    })
    let result = await backend.run(
      { command: effectiveCommand, cwd: ctx.cwd, timeoutMs: timeout, maxOutputChars: 100_000 },
      policy,
    )
    if (result.violation) {
      ctx.onSandboxEvent?.({
        type: 'sandbox.violation',
        backend: backend.name(),
        sessionId: ctx.sessionId,
        sandboxMode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        toolName: 'bash',
        summary: effectiveCommand,
        violationKind: result.violation.kind,
      })
    }
    if (
      result.violation &&
      (
        policy.approvalPolicy === 'on-failure' ||
        (policy.approvalPolicy === 'on-request' && (preapproved === 'allow' || preapproved === 'allow_session'))
      )
    ) {
      ctx.onSandboxEvent?.({
        type: 'sandbox.escalation.requested',
        backend: backend.name(),
        sessionId: ctx.sessionId,
        sandboxMode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        toolName: 'bash',
        summary: effectiveCommand,
        violationKind: result.violation.kind,
      })
      const decision = await ctx.permissions?.ask('bash', `Run outside current sandbox: ${effectiveCommand}`, {
        phase: 'escalation',
        violationKind: result.violation.kind,
        sessionScope: permissionScope(result.violation.kind),
      })
      if (decision === 'allow' || decision === 'allow_session') {
        policy = widenSandboxPolicy(policy, result.violation.kind)
        backend = await resolveSandboxBackend(policy)
        ctx.onSandboxEvent?.({
          type: 'sandbox.escalation.allowed',
          backend: backend.name(),
          sessionId: ctx.sessionId,
          sandboxMode: policy.mode,
          approvalPolicy: policy.approvalPolicy,
          toolName: 'bash',
          summary: effectiveCommand,
          violationKind: result.violation.kind,
        })
        result = await backend.run(
          { command: effectiveCommand, cwd: ctx.cwd, timeoutMs: timeout, maxOutputChars: 100_000 },
          policy,
        )
      } else {
        ctx.onSandboxEvent?.({
          type: 'sandbox.escalation.denied',
          backend: backend.name(),
          sessionId: ctx.sessionId,
          sandboxMode: policy.mode,
          approvalPolicy: policy.approvalPolicy,
          toolName: 'bash',
          summary: effectiveCommand,
        })
      }
    }
    ctx.onSandboxEvent?.({
      type: 'sandbox.command.completed',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'bash',
      summary: effectiveCommand,
      violationKind: result.violation?.kind,
    })
    return formatBashContent(
      result.stdout,
      result.stderr,
      result.exitCode,
      result.timedOut,
      timeout,
      normalized.notes,
    )
  }
}
