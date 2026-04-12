import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureCodebaseIndex,
  refreshCodebaseIndex,
  readCodebaseIndex,
  updateCodebaseIndexWithChangedFiles,
} from '../src/artifacts/codebase_index.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-index-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
  await writeFile(join(root, 'tests', 'a.test.ts'), 'test("x", ()=>{})\n', 'utf8')
  await mkdir(join(root, 'tests', '__pycache__'), { recursive: true })
  await writeFile(join(root, 'tests', '__pycache__', 'noise.pyc'), 'x', 'utf8')
  await mkdir(join(root, '.pytest_cache'), { recursive: true })
  await writeFile(join(root, '.pytest_cache', 'state.json'), '{}', 'utf8')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', merlion: 'node src/index.ts' } }, null, 2),
    'utf8'
  )
  return root
}

test('ensureCodebaseIndex creates .merlion/codebase_index.md', async () => {
  const repo = await makeRepo()
  const artifact = await ensureCodebaseIndex(repo)
  assert.match(artifact.path, /\.merlion\/codebase_index\.md$/)
  assert.match(artifact.content, /# Codebase Index/)
  assert.match(artifact.content, /## Directory Summary/)
  assert.match(artifact.content, /## Guidance Scopes/)
  assert.match(artifact.content, /## Dev Scripts/)
  assert.match(artifact.content, /src\/index\.ts \(scope: src\)/)
  assert.doesNotMatch(artifact.content, /__pycache__|\.pyc|\.pytest_cache/)
})

test('updateCodebaseIndexWithChangedFiles records unique recent files', async () => {
  const repo = await makeRepo()
  await ensureCodebaseIndex(repo)

  await updateCodebaseIndexWithChangedFiles(repo, ['src/index.ts', 'tests/a.test.ts', 'src/index.ts'])
  const text = await readFile(join(repo, '.merlion', 'codebase_index.md'), 'utf8')
  assert.match(text, /## Recent Changed Files/)
  const count = (text.match(/- changed: src\/index\.ts — /g) ?? []).length
  assert.equal(count, 1)
})

test('refreshCodebaseIndex rebuilds structure and keeps recent-changed section', async () => {
  const repo = await makeRepo()
  await updateCodebaseIndexWithChangedFiles(repo, ['src/index.ts'])
  await writeFile(join(repo, 'docs', 'new.md'), '# new\n', 'utf8')

  const out = await refreshCodebaseIndex(repo)
  assert.match(out.content, /docs\/new\.md \(scope: docs\)/)
  assert.match(out.content, /## Recent Changed Files/)
  assert.match(out.content, /- changed: src\/index\.ts — /)
})

test('readCodebaseIndex truncates by token budget', async () => {
  const repo = await makeRepo()
  await mkdir(join(repo, '.merlion'), { recursive: true })
  await writeFile(join(repo, '.merlion', 'codebase_index.md'), `# Codebase Index\n\n${'x'.repeat(6000)}\n`, 'utf8')
  const out = await readCodebaseIndex(repo, { maxTokens: 120 })
  assert.equal(out.truncated, true)
  assert.match(out.text, /truncated/)
  assert.equal(out.tokensEstimate <= 140, true)
})
