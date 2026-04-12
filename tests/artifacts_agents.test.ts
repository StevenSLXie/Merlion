import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadAgentsGuidance } from '../src/artifacts/agents.ts'

async function makeRepo(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-agents-'))
  await mkdir(join(root, '.git'))
  const cwd = join(root, 'apps', 'cli')
  await mkdir(cwd, { recursive: true })
  return { root, cwd }
}

test('loads AGENTS.md from root to cwd hierarchy', async () => {
  const { root, cwd } = await makeRepo()
  await writeFile(join(root, 'AGENTS.md'), '# Root rules\nDo tests first.\n', 'utf8')
  await writeFile(join(root, 'apps', 'AGENTS.md'), '# Apps rules\nPrefer small diffs.\n', 'utf8')

  const result = await loadAgentsGuidance(cwd)

  assert.equal(result.files.length, 2)
  assert.match(result.text, /Root rules/)
  assert.match(result.text, /Apps rules/)
  assert.equal(result.tokensEstimate > 0, true)
})

test('returns empty guidance when no AGENTS.md exists', async () => {
  const { cwd } = await makeRepo()
  const result = await loadAgentsGuidance(cwd)
  assert.equal(result.files.length, 0)
  assert.equal(result.text, '')
  assert.equal(result.tokensEstimate, 0)
  assert.equal(result.truncated, false)
})

test('truncates by token budget', async () => {
  const { root, cwd } = await makeRepo()
  await writeFile(join(root, 'AGENTS.md'), `# Rules\n${'x'.repeat(5000)}\n`, 'utf8')

  const result = await loadAgentsGuidance(cwd, { maxTokens: 100 })
  assert.equal(result.truncated, true)
  assert.match(result.text, /truncated by budget/)
  assert.equal(result.tokensEstimate <= 120, true)
})

test('prefers MERLION.md over AGENTS.md when both exist', async () => {
  const { root, cwd } = await makeRepo()
  await writeFile(join(root, 'AGENTS.md'), '# AGENTS\nlegacy\n', 'utf8')
  await writeFile(join(root, 'MERLION.md'), '# MERLION\npreferred\n', 'utf8')

  const result = await loadAgentsGuidance(cwd)
  assert.match(result.text, /preferred/)
  assert.doesNotMatch(result.text, /legacy/)
})
