import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureGeneratedAgentsMaps } from '../src/artifacts/agents_bootstrap.ts'
import { loadAgentsGuidance } from '../src/artifacts/agents.ts'

async function makeRepo(withRealAgents = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-agents-bootstrap-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src', 'runtime'), { recursive: true })
  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const x = 1\n', 'utf8')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2), 'utf8')
  if (withRealAgents) {
    await writeFile(join(root, 'AGENTS.md'), '# Real map\n', 'utf8')
  }
  return root
}

test('bootstrap generates fallback maps when project has no AGENTS.md', async () => {
  const repo = await makeRepo(false)
  const result = await ensureGeneratedAgentsMaps(repo)

  assert.equal(result.created, true)
  assert.equal(result.reason, 'generated')
  assert.equal(result.generatedFiles.some((x) => x === '.merlion/maps/AGENTS.md'), true)

  const guidance = await loadAgentsGuidance(join(repo, 'src', 'runtime'))
  assert.equal(guidance.text.includes('(generated map)'), true)
  assert.equal(guidance.files.length > 0, true)

  const second = await ensureGeneratedAgentsMaps(repo)
  assert.equal(second.created, false)
  assert.equal(second.reason, 'up_to_date')
})

test('bootstrap skips when real AGENTS.md exists in project', async () => {
  const repo = await makeRepo(true)
  const result = await ensureGeneratedAgentsMaps(repo)

  assert.equal(result.created, false)
  assert.equal(result.reason, 'project_agents_exists')

  const guidance = await loadAgentsGuidance(repo)
  assert.match(guidance.text, /Real map/)
  assert.equal(guidance.text.includes('(generated map)'), false)
})
