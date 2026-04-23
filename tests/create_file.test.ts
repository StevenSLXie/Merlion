import { access, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { createFileTool } from '../src/tools/builtin/create_file.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-create-file-'))
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return {
    async ask() {
      return value
    }
  }
}

test('creates new file and parent directories', async () => {
  const cwd = await makeTempDir()
  const result = await createFileTool.execute(
    { path: 'src/new/file.ts', content: 'export const x = 1\n' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /Created/)

  const target = join(cwd, 'src/new/file.ts')
  const text = await readFile(target, 'utf8')
  assert.equal(text, 'export const x = 1\n')
})

test('fails when file already exists', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'exists.ts')
  await writeFile(target, 'old', 'utf8')

  const result = await createFileTool.execute(
    { path: 'exists.ts', content: 'new' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /already exists/i)
  assert.equal(await readFile(target, 'utf8'), 'old')
})

test('denied permission blocks write', async () => {
  const cwd = await makeTempDir()
  const result = await createFileTool.execute(
    { path: 'nope.ts', content: 'x' },
    { cwd, permissions: permission('deny') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Permission denied/i)

  await assert.rejects(() => access(join(cwd, 'nope.ts'), constants.F_OK))
})

test('read-only sandbox blocks create_file before mutation', async () => {
  const cwd = await makeTempDir()
  const result = await createFileTool.execute(
    { path: 'nope.ts', content: 'x' },
    {
      cwd,
      permissions: permission('allow'),
      sandbox: {
        policy: resolveSandboxPolicy({ cwd, sandboxMode: 'read-only', approvalPolicy: 'untrusted' }),
        backend: {
          name: () => 'test',
          isAvailableForPolicy: async () => true,
          run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
        },
      },
    }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /read-only/i)
  await assert.rejects(() => access(join(cwd, 'nope.ts'), constants.F_OK))
})

test('outside-workspace path is rejected', async () => {
  const cwd = await makeTempDir()
  const outsideBase = await makeTempDir()
  const outsidePath = join(outsideBase, 'outside.ts')

  const result = await createFileTool.execute(
    { path: outsidePath, content: 'x' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /outside the workspace/i)

  await assert.rejects(() => access(outsidePath, constants.F_OK))
})

test('outside-workspace check still works for absolute paths', async () => {
  const cwd = await makeTempDir()
  const rootPath = isAbsolute('/tmp') ? '/tmp/merlion-outside.ts' : join(cwd, '../merlion-outside.ts')

  const result = await createFileTool.execute(
    { path: rootPath, content: 'x' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /outside the workspace/i)

  await assert.rejects(async () => {
    const st = await stat(rootPath)
    if (st) throw new Error('should not exist')
  })
})

test('rejects malformed placeholder-like path tokens', async () => {
  const cwd = await makeTempDir()
  const result = await createFileTool.execute(
    { path: ':=', content: 'x' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /placeholder|malformed/i)
})

test('rejects creating files through symlinked parent directories', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink test is not reliable on Windows CI')
    return
  }

  const cwd = await makeTempDir()
  const outside = await makeTempDir()
  await symlink(outside, join(cwd, 'linked'))

  const result = await createFileTool.execute(
    { path: 'linked/escape.txt', content: 'x' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /outside the workspace|symlink/i)
  await assert.rejects(() => access(join(outside, 'escape.txt'), constants.F_OK))
})
