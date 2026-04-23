import { mkdtemp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { bashTool } from '../src/tools/builtin/bash.ts'
import type { RuntimeSandboxEvent } from '../src/runtime/events.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'
import type { SandboxBackend, SandboxRunResult } from '../src/sandbox/backend.ts'
import { resolveSandboxBackend } from '../src/sandbox/resolve.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-bash-'))
}

async function canEscalateToRealSandbox(cwd: string): Promise<boolean> {
  try {
    await resolveSandboxBackend(resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write' }))
    return true
  } catch {
    return false
  }
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return {
    async ask() {
      return value
    }
  }
}

function countingPermission(value: 'allow' | 'deny' | 'allow_session') {
  let calls = 0
  const store: PermissionStore = {
    async ask() {
      calls += 1
      return value
    },
  }
  return { store, getCalls: () => calls }
}

class StubSandboxBackend implements SandboxBackend {
  private readonly results: SandboxRunResult[]

  constructor(results: SandboxRunResult[]) {
    this.results = [...results]
  }

  name(): string {
    return 'stub-sandbox'
  }

  async isAvailableForPolicy(): Promise<boolean> {
    return true
  }

  async run(): Promise<SandboxRunResult> {
    const next = this.results.shift()
    if (!next) throw new Error('unexpected sandbox run')
    return next
  }
}

test('runs safe command', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: 'printf "hello"' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /hello/)
  assert.match(result.content, /\[exit: 0\]/)
})

test('blocks high-risk command', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: 'rm -rf /' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Blocked/i)
})

test('warn-level command denied by permission', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: 'git reset --hard' },
    { cwd, permissions: permission('deny') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Permission denied/i)
})

test('times out long-running command', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: 'sleep 2', timeout: 100 },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /timed out/i)
})

test('autocorrects accidental .git prefix', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: '.git --version' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /autocorrect/i)
  assert.match(result.content, /git version/i)
  assert.match(result.content, /\[exit: 0\]/)
})

test('autocorrects accidental shell prompt marker prefix', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: '>> pwd' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /autocorrect/i)
  assert.match(result.content, /\[exit: 0\]/)
  await assert.rejects(stat(join(cwd, 'pwd')))
})

test('uses pipefail so failed pipeline returns error', async () => {
  const cwd = await makeTempDir()
  const result = await bashTool.execute(
    { command: 'cat missing.txt | head -1' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /missing\.txt/)
  assert.match(result.content, /\[exit: 1\]/)
})

test('returns promptly when command exits but background child keeps stdio open', async () => {
  const cwd = await makeTempDir()
  const startedAt = Date.now()
  const result = await bashTool.execute(
    { command: 'node -e "setTimeout(() => {}, 2200)" & echo started', timeout: 5_000 },
    { cwd, permissions: permission('allow') }
  )
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.isError, false)
  assert.match(result.content, /started/)
  assert.match(result.content, /\[exit: 0\]/)
  assert.ok(elapsedMs < 1_800, `Expected fast settlement, got ${elapsedMs}ms`)
})

test('sandbox violation can escalate on failure with approval', async (t) => {
  const cwd = await makeTempDir()
  if (!(await canEscalateToRealSandbox(cwd))) {
    t.skip('real sandbox backend unavailable for escalation test')
    return
  }
  const events: RuntimeSandboxEvent[] = []
  const result = await bashTool.execute(
    { command: 'printf "sandbox fallback"' },
    {
      cwd,
      permissions: permission('allow'),
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'on-failure' }),
        backend: new StubSandboxBackend([
          {
            stdout: '',
            stderr: 'Operation not permitted',
            exitCode: 1,
            timedOut: false,
            violation: { kind: 'fs-write', detail: 'blocked by sandbox' },
          },
        ]),
      },
      onSandboxEvent: (event) => events.push(event),
    }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /sandbox fallback/)
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.requested'))
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.allowed'))
})

test('on-request asks before running even safe sandboxed bash commands', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')
  const result = await bashTool.execute(
    { command: 'printf "preflight"' },
    {
      cwd,
      permissions: permissions.store,
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }),
        backend: new StubSandboxBackend([{ stdout: 'preflight', stderr: '', exitCode: 0, timedOut: false }]),
      },
    }
  )

  assert.equal(result.isError, false)
  assert.equal(permissions.getCalls(), 1)
  assert.match(result.content, /preflight/)
})

test('on-request asks again before sandbox escalation', async (t) => {
  const cwd = await makeTempDir()
  if (!(await canEscalateToRealSandbox(cwd))) {
    t.skip('real sandbox backend unavailable for escalation test')
    return
  }
  const permissions = countingPermission('allow')
  const result = await bashTool.execute(
    { command: 'printf "escalated"' },
    {
      cwd,
      permissions: permissions.store,
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'on-request' }),
        backend: new StubSandboxBackend([
          {
            stdout: '',
            stderr: 'Operation not permitted',
            exitCode: 1,
            timedOut: false,
            violation: { kind: 'fs-write', detail: 'blocked by sandbox' },
          },
        ]),
      },
    }
  )

  assert.equal(result.isError, false)
  assert.equal(permissions.getCalls(), 2)
  assert.match(result.content, /escalated/)
})

test('on-failure does not ask before running safe sandboxed bash commands', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')
  const result = await bashTool.execute(
    { command: 'printf "safe"' },
    {
      cwd,
      permissions: permissions.store,
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' }),
        backend: new StubSandboxBackend([{ stdout: 'safe', stderr: '', exitCode: 0, timedOut: false }]),
      },
    }
  )

  assert.equal(result.isError, false)
  assert.equal(permissions.getCalls(), 0)
  assert.match(result.content, /safe/)
})

test('on-request denied preflight stops before sandbox execution', async () => {
  const cwd = await makeTempDir()
  const events: RuntimeSandboxEvent[] = []
  const result = await bashTool.execute(
    { command: 'printf "nope"' },
    {
      cwd,
      permissions: permission('deny'),
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'on-request' }),
        backend: new StubSandboxBackend([
          {
            stdout: '',
            stderr: 'Operation not permitted',
            exitCode: 1,
            timedOut: false,
            violation: { kind: 'fs-write', detail: 'blocked by sandbox' },
          },
        ]),
      },
      onSandboxEvent: (event) => events.push(event),
    }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Permission denied/i)
  assert.ok(!events.some((event) => event.type === 'sandbox.command.started'))
})
