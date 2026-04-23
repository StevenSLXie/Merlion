import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'
import type { RuntimeSandboxEvent } from '../src/runtime/events.ts'
import { authorizeMutation, authorizeNetworkAccess } from '../src/tools/builtin/fs_common.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'merlion-fs-common-'))
}

function countingPermission(decision: 'allow' | 'deny' | 'allow_session') {
  let calls = 0
  const store: PermissionStore = {
    async ask() {
      calls += 1
      return decision
    },
  }
  return { store, getCalls: () => calls }
}

function stubSandbox(cwd: string, policy = resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' })) {
  return {
    policy,
    backend: {
      name: () => 'test',
      isAvailableForPolicy: async () => true,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    },
  }
}

test('authorizeMutation skips prompt when sandbox already allows write', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await authorizeMutation(
    { cwd, permissions: permissions.store, sandbox: stubSandbox(cwd) },
    'write_file',
    join(cwd, 'allowed.txt'),
    'Write: allowed.txt',
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(permissions.getCalls(), 0)
})

test('authorizeMutation fails without prompt when policy blocks and approval is never', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await authorizeMutation(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'never' })),
    },
    'write_file',
    join(cwd, 'blocked.txt'),
    'Write: blocked.txt',
  )

  assert.equal(result.ok, false)
  assert.equal(permissions.getCalls(), 0)
})

test('authorizeMutation can escalate on failure after approval', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')
  const events: RuntimeSandboxEvent[] = []

  const result = await authorizeMutation(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'on-failure' })),
      onSandboxEvent: (event) => events.push(event),
    },
    'write_file',
    join(cwd, 'escalated.txt'),
    'Write: escalated.txt',
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(permissions.getCalls(), 1)
  assert.ok(events.some((event) => event.type === 'sandbox.violation' && event.violationKind === 'fs-write'))
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.requested' && event.violationKind === 'fs-write'))
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.allowed' && event.violationKind === 'fs-write'))
})

test('authorizeMutation returns permission denied when escalation is rejected', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('deny')

  const result = await authorizeMutation(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'on-failure' })),
    },
    'write_file',
    join(cwd, 'blocked.txt'),
    'Write: blocked.txt',
  )

  assert.deepEqual(result, { ok: false, error: '[Permission denied]' })
  assert.equal(permissions.getCalls(), 1)
})

test('authorizeMutation rejects protected deny-write path without prompting', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await authorizeMutation(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({
        cwd,
        sandboxMode: 'read-only',
        approvalPolicy: 'on-failure',
        denyWrite: ['.merlion/checkpoints'],
      })),
    },
    'write_file',
    join(cwd, '.merlion', 'checkpoints', 'locked.txt'),
    'Write: .merlion/checkpoints/locked.txt',
  )

  assert.deepEqual(result, { ok: false, error: 'Path is blocked by sandbox deny-write policy.' })
  assert.equal(permissions.getCalls(), 0)
})

test('authorizeMutation on-request prompts even for already-allowed writes', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await authorizeMutation(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' })),
    },
    'write_file',
    join(cwd, 'prompted.txt'),
    'Write: prompted.txt',
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(permissions.getCalls(), 1)
})

test('authorizeNetworkAccess on-request prompts before allowed network access', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')

  const result = await authorizeNetworkAccess(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({
        cwd,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkMode: 'full',
      })),
    },
    'fetch',
    'Fetch URL: https://example.com',
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(permissions.getCalls(), 1)
})

test('authorizeNetworkAccess emits sandbox events for on-failure escalation', async () => {
  const cwd = await makeTempDir()
  const permissions = countingPermission('allow')
  const events: RuntimeSandboxEvent[] = []

  const result = await authorizeNetworkAccess(
    {
      cwd,
      permissions: permissions.store,
      sandbox: stubSandbox(cwd, resolveSandboxPolicy({
        cwd,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-failure',
        networkMode: 'off',
      })),
      onSandboxEvent: (event) => events.push(event),
    },
    'fetch',
    'Fetch URL: https://example.com',
  )

  assert.deepEqual(result, { ok: true })
  assert.ok(events.some((event) => event.type === 'sandbox.violation' && event.violationKind === 'network'))
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.requested' && event.violationKind === 'network'))
  assert.ok(events.some((event) => event.type === 'sandbox.escalation.allowed' && event.violationKind === 'network'))
})
