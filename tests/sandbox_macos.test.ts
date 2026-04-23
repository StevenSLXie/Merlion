import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { inferMacOSSandboxViolation, MacOSSandboxBackend } from '../src/sandbox/macos.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'
import { resolveSandboxBackend } from '../src/sandbox/resolve.ts'

async function makeSandbox(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'merlion-macos-sandbox-'))
}

const isDarwin = process.platform === 'darwin'

test('macOS workspace-write resolves to the real sandbox backend', async (t) => {
  if (!isDarwin) {
    t.skip('macOS-only test')
    return
  }

  const cwd = await makeSandbox()
  try {
    const backend = await resolveSandboxBackend(resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write' }))
    assert.equal(backend.name(), 'macos-sandbox-exec')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('macOS workspace-write allows writes inside the writable root', async (t) => {
  if (!isDarwin) {
    t.skip('macOS-only test')
    return
  }

  const cwd = await makeSandbox()
  try {
    const backend = new MacOSSandboxBackend()
    const policy = resolveSandboxPolicy({ cwd, sandboxMode: 'workspace-write', approvalPolicy: 'never' })
    const result = await backend.run(
      { command: 'mkdir -p nested && printf ok > nested/out.txt', cwd, timeoutMs: 10_000 },
      policy,
    )

    assert.equal(result.exitCode, 0, `stderr=${result.stderr}`)
    assert.equal(await readFile(join(cwd, 'nested', 'out.txt'), 'utf8'), 'ok')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('macOS workspace-write deny-write blocks writes to denied subpaths', async (t) => {
  if (!isDarwin) {
    t.skip('macOS-only test')
    return
  }

  const cwd = await makeSandbox()
  try {
    await mkdir(join(cwd, 'blocked'), { recursive: true })
    const backend = new MacOSSandboxBackend()
    const policy = resolveSandboxPolicy({
      cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      denyWrite: ['blocked'],
    })
    const result = await backend.run(
      { command: 'printf nope > blocked/out.txt', cwd, timeoutMs: 10_000 },
      policy,
    )

    assert.notEqual(result.exitCode, 0)
    assert.equal(result.violation?.kind, 'fs-write')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('macOS sandbox deny-read blocks file reads on matching paths', async (t) => {
  if (!isDarwin) {
    t.skip('macOS-only test')
    return
  }

  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, '.env'), 'SECRET=1\n', 'utf8')
    const backend = new MacOSSandboxBackend()
    const policy = resolveSandboxPolicy({
      cwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      denyRead: ['.env'],
    })
    const result = await backend.run(
      { command: '/bin/cat .env', cwd, timeoutMs: 10_000 },
      policy,
    )

    assert.notEqual(result.exitCode, 0)
    assert.equal(result.violation?.kind, 'fs-read')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('macOS mixed read+write command is classified as fs-write', () => {
  const violation = inferMacOSSandboxViolation('grep foo input.txt > out.txt', 'Operation not permitted')
  assert.equal(violation?.kind, 'fs-write')
})
