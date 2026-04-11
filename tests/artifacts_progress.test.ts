import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureProgressArtifact,
  readProgressArtifact,
  updateProgressArtifact,
} from '../src/artifacts/progress.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-progress-'))
  await mkdir(join(root, '.git'))
  return root
}

test('ensureProgressArtifact creates template file', async () => {
  const repo = await makeRepo()
  const artifact = await ensureProgressArtifact(repo, 'Ship CLI UX')
  assert.match(artifact.path, /\.merlion\/progress\.md$/)
  assert.match(artifact.content, /## Objective/)
  assert.match(artifact.content, /Ship CLI UX/)
})

test('updateProgressArtifact merges sections without duplication', async () => {
  const repo = await makeRepo()
  await ensureProgressArtifact(repo, 'Initial objective')

  await updateProgressArtifact(repo, {
    done: ['added AGENTS loader'],
    next: ['implement progress artifact'],
  })
  await updateProgressArtifact(repo, {
    done: ['added AGENTS loader', 'added tests'],
    blockers: ['none currently'],
    decisions: ['prefer markdown artifact'],
  })

  const text = await readFile(join(repo, '.merlion', 'progress.md'), 'utf8')
  assert.match(text, /added AGENTS loader/)
  assert.match(text, /added tests/)
  assert.match(text, /none currently/)
  assert.match(text, /prefer markdown artifact/)
})

test('readProgressArtifact truncates by token budget', async () => {
  const repo = await makeRepo()
  await updateProgressArtifact(repo, {
    objective: `Build context memory ${'x'.repeat(4000)}`,
  })

  const out = await readProgressArtifact(repo, { maxTokens: 120 })
  assert.equal(out.truncated, true)
  assert.match(out.text, /truncated/)
  assert.equal(out.tokensEstimate <= 140, true)
})
