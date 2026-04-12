import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { editFileTool } from '../src/tools/builtin/edit_file.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-edit-file-'))
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return {
    async ask() {
      return value
    }
  }
}

test('replaces exact unique match', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'const a = 1\nconst b = 2\n', 'utf8')

  const result = await editFileTool.execute(
    { path: 'sample.ts', old_string: 'const b = 2', new_string: 'const b = 3' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /Edited/)
  assert.equal(result.uiPayload?.kind, 'edit_diff')
  assert.equal(result.uiPayload?.addedLines, 1)
  assert.equal(result.uiPayload?.removedLines, 1)
  assert.deepEqual(result.uiPayload?.hunks[0]?.lines, [
    { type: 'remove', text: 'const b = 2' },
    { type: 'add', text: 'const b = 3' },
  ])
  assert.equal(await readFile(target, 'utf8'), 'const a = 1\nconst b = 3\n')
})

test('fails when old_string not found', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'const a = 1\n', 'utf8')

  const result = await editFileTool.execute(
    { path: 'sample.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /not found/i)
  assert.equal(await readFile(target, 'utf8'), 'const a = 1\n')
})

test('fails when old_string has multiple matches', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'same\nsame\n', 'utf8')

  const result = await editFileTool.execute(
    { path: 'sample.ts', old_string: 'same', new_string: 'diff' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /occurrences/i)
  assert.equal(await readFile(target, 'utf8'), 'same\nsame\n')
})

test('denied permission blocks write', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'const a = 1\n', 'utf8')

  const result = await editFileTool.execute(
    { path: 'sample.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
    { cwd, permissions: permission('deny') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Permission denied/i)
  assert.equal(await readFile(target, 'utf8'), 'const a = 1\n')
})

test('outside-workspace path is rejected', async () => {
  const cwd = await makeTempDir()
  const outsideBase = await makeTempDir()
  const outsidePath = join(outsideBase, 'outside.ts')
  await writeFile(outsidePath, 'const a = 1\n', 'utf8')

  const result = await editFileTool.execute(
    { path: outsidePath, old_string: 'const a = 1', new_string: 'const a = 2' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /outside the workspace/i)
  assert.equal(await readFile(outsidePath, 'utf8'), 'const a = 1\n')
  await access(outsidePath, constants.F_OK)
})

test('supports file_path alias', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'const a = 1\n', 'utf8')

  const result = await editFileTool.execute(
    { file_path: 'sample.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.equal(await readFile(target, 'utf8'), 'const a = 2\n')
})

test('replace_all updates all matches', async () => {
  const cwd = await makeTempDir()
  const target = join(cwd, 'sample.ts')
  await writeFile(target, 'same\nsame\n', 'utf8')

  const result = await editFileTool.execute(
    { path: 'sample.ts', old_string: 'same', new_string: 'diff', replace_all: true },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, false)
  assert.match(result.content, /replace_all=2/)
  assert.equal(await readFile(target, 'utf8'), 'diff\ndiff\n')
})

test('rejects unresolved template path before file IO', async () => {
  const cwd = await makeTempDir()
  const result = await editFileTool.execute(
    { path: '{{target}}', old_string: 'a', new_string: 'b' },
    { cwd, permissions: permission('allow') }
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /unresolved template/i)
})
