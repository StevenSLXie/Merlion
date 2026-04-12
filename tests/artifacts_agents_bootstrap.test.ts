import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureGeneratedAgentsMaps } from '../src/artifacts/agents_bootstrap.ts'
import { loadAgentsGuidance } from '../src/artifacts/agents.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function makeRepo(withRootGuidance = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-agents-bootstrap-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src', 'runtime'), { recursive: true })
  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const x = 1\n', 'utf8')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2), 'utf8')
  if (withRootGuidance) {
    await writeFile(join(root, 'MERLION.md'), '# Real map\n', 'utf8')
  }
  return root
}

test('bootstrap generates fallback maps when project has no AGENTS.md', async () => {
  const repo = await makeRepo(false)
  const result = await ensureGeneratedAgentsMaps(repo)

  assert.equal(result.created, true)
  assert.equal(result.reason, 'generated')
  assert.equal(result.generatedFiles.some((x) => x === '.merlion/maps/MERLION.md'), true)

  const guidance = await loadAgentsGuidance(join(repo, 'src', 'runtime'))
  assert.equal(guidance.text.includes('(generated map)'), true)
  assert.equal(guidance.files.length > 0, true)
  assert.match(guidance.text, /## Purpose/)

  const second = await ensureGeneratedAgentsMaps(repo)
  assert.equal(second.created, false)
  assert.equal(second.reason, 'up_to_date')
})

test('bootstrap still generates subdirectory maps when root guidance exists', async () => {
  const repo = await makeRepo(true)
  const result = await ensureGeneratedAgentsMaps(repo)

  assert.equal(result.created, true)
  assert.equal(result.reason, 'generated')
  assert.equal(result.generatedFiles.some((x) => x.endsWith('/src/MERLION.md')), true)
  assert.equal(result.generatedFiles.some((x) => x === '.merlion/maps/MERLION.md'), false)

  const guidance = await loadAgentsGuidance(repo)
  assert.match(guidance.text, /Real map/)
  assert.equal(guidance.text.includes('(generated map)'), false)
})

test('bootstrap force option regenerates maps even when head is unchanged', async () => {
  const repo = await makeRepo(false)
  const first = await ensureGeneratedAgentsMaps(repo)
  assert.equal(first.created, true)

  const second = await ensureGeneratedAgentsMaps(repo)
  assert.equal(second.created, false)
  assert.equal(second.reason, 'up_to_date')

  const forced = await ensureGeneratedAgentsMaps(repo, { force: true })
  assert.equal(forced.created, true)
  assert.equal(forced.reason, 'generated')
})

test('bootstrap does not execute shell substitutions from directory names', async () => {
  const repo = await makeRepo(false)
  await mkdir(join(repo, '$(touch SHOULD_NOT_EXIST)'), { recursive: true })

  const marker = join(repo, 'SHOULD_NOT_EXIST')
  assert.equal(await exists(marker), false)

  await ensureGeneratedAgentsMaps(repo)
  assert.equal(await exists(marker), false)
})
