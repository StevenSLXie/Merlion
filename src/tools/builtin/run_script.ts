import type { ToolDefinition } from '../types.js'
import { parsePositiveInt } from './fs_common.ts'
import { NoSandboxBackend } from '../../sandbox/no_sandbox.ts'
import { createUnsandboxedPolicy, widenSandboxPolicy } from '../../sandbox/policy.ts'
import { resolveSandboxBackend } from '../../sandbox/resolve.ts'
import type { SandboxViolation } from '../../sandbox/backend.ts'

function isSafeScriptName(name: string): boolean {
  return /^[A-Za-z0-9:_-]+$/.test(name)
}

function permissionScope(kind: SandboxViolation['kind'] | 'preflight'): string {
  return `run_script:${kind}`
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
    const commandSummary = `npm run ${script}`
    let policy = ctx.sandbox?.policy ?? createUnsandboxedPolicy(ctx.cwd)
    let backend = ctx.sandbox?.backend ?? new NoSandboxBackend()
    if (!ctx.sandbox) {
      ctx.onSandboxEvent?.({
        type: 'sandbox.warning',
        backend: backend.name(),
        sessionId: ctx.sessionId,
        sandboxMode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        toolName: 'run_script',
        summary: `ctx.sandbox missing; running unsandboxed: ${commandSummary}`,
      })
    }
    const preapproved = policy.approvalPolicy === 'on-request'
      ? await ctx.permissions?.ask('run_script', `Run script: ${commandSummary}`, {
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
    ctx.onSandboxEvent?.({
      type: 'sandbox.backend.selected',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'run_script',
      summary: commandSummary,
    })
    ctx.onSandboxEvent?.({
      type: 'sandbox.command.started',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'run_script',
      summary: commandSummary,
    })
    let result = await backend.run(
      { command: commandSummary, cwd: ctx.cwd, timeoutMs, maxOutputChars: 120_000 },
      policy,
    )
    if (result.violation) {
      ctx.onSandboxEvent?.({
        type: 'sandbox.violation',
        backend: backend.name(),
        sessionId: ctx.sessionId,
        sandboxMode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        toolName: 'run_script',
        summary: commandSummary,
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
        toolName: 'run_script',
        summary: commandSummary,
        violationKind: result.violation.kind,
      })
      const decision = await ctx.permissions?.ask('run_script', `Run outside current sandbox: ${commandSummary}`, {
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
          toolName: 'run_script',
          summary: commandSummary,
          violationKind: result.violation.kind,
        })
        result = await backend.run(
          { command: commandSummary, cwd: ctx.cwd, timeoutMs, maxOutputChars: 120_000 },
          policy,
        )
      } else {
        ctx.onSandboxEvent?.({
          type: 'sandbox.escalation.denied',
          backend: backend.name(),
          sessionId: ctx.sessionId,
          sandboxMode: policy.mode,
          approvalPolicy: policy.approvalPolicy,
          toolName: 'run_script',
          summary: commandSummary,
        })
        return { content: '[Permission denied]', isError: true }
      }
    }
    ctx.onSandboxEvent?.({
      type: 'sandbox.command.completed',
      backend: backend.name(),
      sessionId: ctx.sessionId,
      sandboxMode: policy.mode,
      approvalPolicy: policy.approvalPolicy,
      toolName: 'run_script',
      summary: commandSummary,
      violationKind: result.violation?.kind,
    })
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
