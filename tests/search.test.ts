import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { searchTool } from '../src/tools/builtin/search.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-search-'))
}

test('finds matches with line numbers', async () => {
  const cwd = await makeTempDir()
  await writeFile(join(cwd, 'a.ts'), 'export const alpha = 1\nconst beta = 2\n', 'utf8')
  await writeFile(join(cwd, 'b.ts'), 'const alphaBeta = true\n', 'utf8')

  const result = await searchTool.execute({ pattern: 'alpha' }, { cwd })

  assert.equal(result.isError, false)
  assert.match(result.content, /a\.ts:1:/)
})

test('returns no matches marker', async () => {
  const cwd = await makeTempDir()
  await writeFile(join(cwd, 'a.ts'), 'const x = 1\n', 'utf8')

  const result = await searchTool.execute({ pattern: 'zzzz_not_found' }, { cwd })

  assert.equal(result.isError, false)
  assert.equal(result.content, '(no matches found)')
})

test('errors on invalid pattern input', async () => {
  const cwd = await makeTempDir()
  const result = await searchTool.execute({ pattern: '' }, { cwd })

  assert.equal(result.isError, true)
  assert.match(result.content, /invalid pattern/i)
})

test('respects provided relative path', async () => {
  const cwd = await makeTempDir()
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(cwd, 'other'), { recursive: true })
  await writeFile(join(cwd, 'src', 'a.ts'), 'const hit = 1\n', 'utf8')
  await writeFile(join(cwd, 'other', 'b.ts'), 'const hit = 2\n', 'utf8')

  const result = await searchTool.execute({ pattern: 'hit', path: 'src' }, { cwd })

  assert.equal(result.isError, false)
  assert.match(result.content, /src\/a\.ts:1:/)
  assert.doesNotMatch(result.content, /other\/b\.ts:1:/)
})

