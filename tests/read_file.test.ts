import { mkdtemp, mkdir, writeFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { readFileTool } from '../src/tools/builtin/read_file.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-read-file-'))
}

test('reads full file with line numbers', async () => {
  const cwd = await makeTempDir()
  const file = join(cwd, 'sample.ts')
  await writeFile(file, 'const a = 1;\nconst b = 2;\n', 'utf8')

  const result = await readFileTool.execute({ path: 'sample.ts' }, { cwd })

  assert.equal(result.isError, false)
  assert.equal(result.content, '1\tconst a = 1;\n2\tconst b = 2;')
})

test('reads requested line range', async () => {
  const cwd = await makeTempDir()
  const file = join(cwd, 'sample.ts')
  await writeFile(file, 'a\nb\nc\nd\n', 'utf8')

  const result = await readFileTool.execute(
    { path: 'sample.ts', start_line: 2, end_line: 3 },
    { cwd }
  )

  assert.equal(result.isError, false)
  assert.equal(result.content, '2\tb\n3\tc')
})

test('supports file_path + offset/limit aliases', async () => {
  const cwd = await makeTempDir()
  const file = join(cwd, 'sample.ts')
  await writeFile(file, 'a\nb\nc\nd\n', 'utf8')

  const result = await readFileTool.execute(
    { file_path: 'sample.ts', offset: 3, limit: 2 },
    { cwd }
  )

  assert.equal(result.isError, false)
  assert.equal(result.content, '3\tc\n4\td')
})

test('returns error for missing file', async () => {
  const cwd = await makeTempDir()

  const result = await readFileTool.execute({ path: 'missing.ts' }, { cwd })

  assert.equal(result.isError, true)
  assert.match(result.content, /not found/i)
})

test('returns error for directory path', async () => {
  const cwd = await makeTempDir()
  const dir = join(cwd, 'src')
  await mkdir(dir)

  const result = await readFileTool.execute({ path: 'src' }, { cwd })

  assert.equal(result.isError, true)
  assert.match(result.content, /directory/i)
})

test('returns empty marker for empty file', async () => {
  const cwd = await makeTempDir()
  const file = join(cwd, 'empty.txt')
  await writeFile(file, '', 'utf8')

  const result = await readFileTool.execute({ path: 'empty.txt' }, { cwd })

  assert.equal(result.isError, false)
  assert.equal(result.content, '(empty file)')
})

test('returns error for >1 GiB file', async () => {
  const cwd = await makeTempDir()
  const file = join(cwd, 'huge.log')
  await writeFile(file, '', 'utf8')
  await truncate(file, 1024 * 1024 * 1024 + 1)

  const result = await readFileTool.execute({ path: 'huge.log' }, { cwd })

  assert.equal(result.isError, true)
  assert.match(result.content, /> 1 GiB/i)
})
