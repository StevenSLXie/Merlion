import test from 'node:test'
import assert from 'node:assert/strict'

import { createUnsandboxedPolicy, resolveSandboxPolicy, widenSandboxPolicy } from '../src/sandbox/policy.ts'

test('explicit writable roots do not silently widen back to cwd', () => {
  const policy = resolveSandboxPolicy({
    cwd: '/repo',
    sandboxMode: 'workspace-write',
    writableRoots: ['src'],
  })

  assert.deepEqual(policy.writableRoots, ['/repo/src'])
})

test('widenSandboxPolicy preserves deny-write while broadening access', () => {
  const policy = resolveSandboxPolicy({
    cwd: '/repo',
    sandboxMode: 'read-only',
    approvalPolicy: 'on-failure',
    networkMode: 'off',
    denyRead: ['.env'],
    denyWrite: ['.merlion/checkpoints'],
  })

  const widened = widenSandboxPolicy(policy, 'network')

  assert.equal(widened.mode, 'workspace-write')
  assert.equal(widened.networkMode, 'full')
  assert.deepEqual(widened.denyWrite, ['/repo/.merlion/checkpoints'])
  assert.deepEqual(widened.writableRoots, ['/'])
})

test('createUnsandboxedPolicy is explicit full-access policy', () => {
  const policy = createUnsandboxedPolicy('/repo')

  assert.equal(policy.mode, 'danger-full-access')
  assert.equal(policy.approvalPolicy, 'never')
  assert.equal(policy.networkMode, 'full')
})
