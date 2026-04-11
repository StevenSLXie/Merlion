import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildOrientationContext } from '../src/context/orientation.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-orient-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.merlion'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# Repo Rules\nAlways run tests.\n', 'utf8')
  await writeFile(join(root, '.merlion', 'progress.md'), '# Merlion Progress\n\n## Objective\nShip it\n', 'utf8')
  await writeFile(join(root, 'docs', 'codebase_index.md'), '# Codebase Index\n\n- src/index.ts\n', 'utf8')
  await writeFile(join(root, 'src', 'index.ts'), 'console.log("hi")\n', 'utf8')
  return root
}

test('buildOrientationContext assembles sections in order', async () => {
  const repo = await makeRepo()
  const orientation = await buildOrientationContext(repo)
  assert.match(orientation.text, /### AGENTS Guidance/)
  assert.match(orientation.text, /### Progress Snapshot/)
  assert.match(orientation.text, /### Codebase Index/)
  assert.equal(orientation.tokensEstimate > 0, true)
})

test('buildOrientationContext respects total budget', async () => {
  const repo = await makeRepo()
  await writeFile(join(repo, 'AGENTS.md'), `# Repo Rules\n${'x'.repeat(6000)}\n`, 'utf8')

  const orientation = await buildOrientationContext(repo, {
    totalTokens: 220,
    agentsTokens: 200,
    progressTokens: 80,
    indexTokens: 120,
  })
  assert.equal(orientation.tokensEstimate <= 230, true)
  assert.equal(orientation.truncated, true)
})
