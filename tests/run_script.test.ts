import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import type { RuntimeSandboxEvent } from '../src/runtime/events.ts'
import type { SandboxBackend, SandboxRunResult } from '../src/sandbox/backend.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'
import { resolveSandboxBackend } from '../src/sandbox/resolve.ts'
import { runScriptTool } from '../src/tools/builtin/run_script.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'merlion-run-script-'))
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
  return { ask: async () => value }
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

test('run_script escalates on sandbox failure when approval is allowed', async (t) => {
  const cwd = await makeTempDir()
  if (!(await canEscalateToRealSandbox(cwd))) {
    t.skip('real sandbox backend unavailable for escalation test')
    return
  }
  const events: RuntimeSandboxEvent[] = []
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "console.log(123)"' } }),
    'utf8',
  )

  const result = await runScriptTool.execute(
    { script: 'test' },
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
            violation: { kind: 'fs-write', detail: 'blocked' },
          },
        ]),
      },
      onSandboxEvent: (event) => events.push(event),
    },
  )

  assert.equal(result.isError, false)
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.allowed'))
})

test('run_script on-request asks before execution', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await runScriptTool.execute(
    { script: 'test' },
    {
      cwd,
      permissions: permissions.store,
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }),
        backend: new StubSandboxBackend([{ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }]),
      },
    },
  )

  assert.equal(result.isError, false)
  assert.equal(permissions.getCalls(), 1)
})

test('run_script on-request asks again before sandbox escalation', async (t) => {
  const cwd = await makeTempDir()
  if (!(await canEscalateToRealSandbox(cwd))) {
    t.skip('real sandbox backend unavailable for escalation test')
    return
  }
  const permissions = countingPermission('allow')
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "console.log(456)"' } }),
    'utf8',
  )

  const result = await runScriptTool.execute(
    { script: 'test' },
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
            violation: { kind: 'fs-write', detail: 'blocked' },
          },
        ]),
      },
    },
  )

  assert.equal(result.isError, false)
  assert.equal(permissions.getCalls(), 2)
})
