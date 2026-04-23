import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBubblewrapInvocation } from '../src/sandbox/linux.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'

async function makeSandbox(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'merlion-linux-sandbox-'))
}

test('bubblewrap invocation unshares network and binds writable roots for workspace-write', async () => {
  const cwd = await makeSandbox()
  try {
    const extra = join(cwd, 'extra')
    await mkdir(extra, { recursive: true })
    const invocation = await buildBubblewrapInvocation(
      { command: 'printf ok', cwd, timeoutMs: 5_000 },
      resolveSandboxPolicy({
        cwd,
        sandboxMode: 'workspace-write',
        networkMode: 'off',
        writableRoots: ['extra'],
      }),
    )

    assert.ok(invocation.argv.includes('--unshare-net'))
    assert.ok(invocation.argv.includes('--ro-bind'))
    assert.ok(invocation.argv.includes('--bind'))
    assert.ok(invocation.argv.includes(cwd))
    assert.ok(invocation.argv.includes(extra))
    assert.deepEqual(invocation.argv.slice(-6), ['/bin/bash', '--noprofile', '--norc', '-o', 'pipefail', '-c', 'printf ok'].slice(-6))
    await rm(invocation.cleanupDir, { recursive: true, force: true })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('bubblewrap invocation overlays deny-read paths with empty masks', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, '.env'), 'SECRET=1\n', 'utf8')
    const invocation = await buildBubblewrapInvocation(
      { command: '/bin/cat .env', cwd, timeoutMs: 5_000 },
      resolveSandboxPolicy({
        cwd,
        sandboxMode: 'read-only',
        denyRead: ['.env'],
      }),
    )

    const roBindIndexes = invocation.argv
      .map((value, index) => ({ value, index }))
      .filter((entry) => entry.value === '--ro-bind')
      .map((entry) => entry.index)
    const hasMaskedEnv = roBindIndexes.some((index) => invocation.argv[index + 2] === join(cwd, '.env'))
    assert.equal(hasMaskedEnv, true)
    await rm(invocation.cleanupDir, { recursive: true, force: true })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
