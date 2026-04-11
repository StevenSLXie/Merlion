import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { appendFileTool } from '../src/tools/builtin/append_file.ts'
import { copyFileTool } from '../src/tools/builtin/copy_file.ts'
import { deleteFileTool } from '../src/tools/builtin/delete_file.ts'
import { globTool } from '../src/tools/builtin/glob.ts'
import { grepTool } from '../src/tools/builtin/grep.ts'
import { listDirTool } from '../src/tools/builtin/list_dir.ts'
import { mkdirTool } from '../src/tools/builtin/mkdir.ts'
import { moveFileTool } from '../src/tools/builtin/move_file.ts'
import { statPathTool } from '../src/tools/builtin/stat_path.ts'
import { writeFileTool } from '../src/tools/builtin/write_file.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-tools-fs-'))
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return { ask: async () => value }
}

test('write_file + append_file + stat_path basic flow', async () => {
  const cwd = await makeTempDir()
  const p = permission('allow')
  const write = await writeFileTool.execute({ path: 'a.txt', content: 'hello' }, { cwd, permissions: p })
  assert.equal(write.isError, false)
  const append = await appendFileTool.execute({ path: 'a.txt', content: '\nworld' }, { cwd, permissions: p })
  assert.equal(append.isError, false)
  const text = await readFile(join(cwd, 'a.txt'), 'utf8')
  assert.equal(text, 'hello\nworld')
  const statResult = await statPathTool.execute({ path: 'a.txt' }, { cwd })
  assert.equal(statResult.isError, false)
  assert.match(statResult.content, /type: file/)
})

test('mkdir + list_dir + glob + grep', async () => {
  const cwd = await makeTempDir()
  const p = permission('allow')
  await mkdirTool.execute({ path: 'src' }, { cwd, permissions: p })
  await writeFile(join(cwd, 'src', 'app.ts'), 'const TOKEN = "abc"\n', 'utf8')
  await writeFile(join(cwd, 'src', 'util.ts'), 'export const util = 1\n', 'utf8')

  const listed = await listDirTool.execute({ path: 'src' }, { cwd })
  assert.equal(listed.isError, false)
  assert.match(listed.content, /app\.ts/)

  const globbed = await globTool.execute({ path: 'src', pattern: '*.ts' }, { cwd })
  assert.equal(globbed.isError, false)
  assert.match(globbed.content, /src\/app\.ts/)
  assert.match(globbed.content, /src\/util\.ts/)

  const grepped = await grepTool.execute({ path: 'src', pattern: 'TOKEN' }, { cwd })
  assert.equal(grepped.isError, false)
  assert.match(grepped.content, /app\.ts/)
})

test('copy_file + move_file + delete_file', async () => {
  const cwd = await makeTempDir()
  const p = permission('allow')
  await writeFile(join(cwd, 'src.txt'), 'x', 'utf8')

  const copied = await copyFileTool.execute({ from_path: 'src.txt', to_path: 'copy.txt' }, { cwd, permissions: p })
  assert.equal(copied.isError, false)
  assert.equal((await readFile(join(cwd, 'copy.txt'), 'utf8')), 'x')

  const moved = await moveFileTool.execute({ from_path: 'copy.txt', to_path: 'moved.txt' }, { cwd, permissions: p })
  assert.equal(moved.isError, false)
  assert.equal((await readFile(join(cwd, 'moved.txt'), 'utf8')), 'x')

  const deleted = await deleteFileTool.execute({ path: 'moved.txt' }, { cwd, permissions: p })
  assert.equal(deleted.isError, false)
  assert.throws(() => accessSync(join(cwd, 'moved.txt'), constants.F_OK))
})

test('mutation tools honor permission deny', async () => {
  const cwd = await makeTempDir()
  const denied = permission('deny')
  const result = await writeFileTool.execute({ path: 'nope.txt', content: 'x' }, { cwd, permissions: denied })
  assert.equal(result.isError, true)
  assert.match(result.content, /Permission denied/i)
  await assert.rejects(() => stat(join(cwd, 'nope.txt')))
})
