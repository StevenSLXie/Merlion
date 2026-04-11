import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { bashTool } from '../src/tools/builtin/bash.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-bash-'))
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return {
    async ask() {
      return value
    }
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
