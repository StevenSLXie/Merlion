import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  buildPathGuidanceDelta,
  createPathGuidanceState,
  extractCandidatePathsFromText,
  extractCandidatePathsFromToolEvent,
} from '../src/context/path_guidance.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-path-guidance-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src', 'runtime'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# root\n', 'utf8')
  await writeFile(join(root, 'src', 'AGENTS.md'), '# src\n', 'utf8')
  await writeFile(join(root, 'src', 'runtime', 'AGENTS.md'), '# runtime\n', 'utf8')
  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export {}\n', 'utf8')
  return root
}

test('buildPathGuidanceDelta loads AGENTS chain once', async () => {
  const repo = await makeRepo()
  const state = createPathGuidanceState()
  const target = join(repo, 'src', 'runtime', 'loop.ts')

  const first = await buildPathGuidanceDelta(repo, [target], state, {
    totalTokens: 1000,
    perFileTokens: 200,
    maxFiles: 10,
  })

  assert.equal(first.loadedFiles.length, 3)
  assert.ok(first.text.includes('AGENTS.md'))
  assert.ok(first.text.includes('src/AGENTS.md'))
  assert.ok(first.text.includes('src/runtime/AGENTS.md'))

  const second = await buildPathGuidanceDelta(repo, [target], state)
  assert.equal(second.loadedFiles.length, 0)
  assert.equal(second.text, '')
})

test('extractCandidatePathsFromToolEvent parses args and output', async () => {
  const repo = await makeRepo()

  const candidates = await extractCandidatePathsFromToolEvent(repo, {
    call: {
      function: {
        arguments: JSON.stringify({ path: './src/runtime/loop.ts', from: './src/AGENTS.md' })
      }
    },
    message: {
      content: 'Read from ./src/runtime/loop.ts successfully.'
    }
  })

  assert.ok(candidates.includes(resolve(repo, 'src/runtime/loop.ts')))
  assert.ok(candidates.includes(resolve(repo, 'src/AGENTS.md')))
})

test('extractCandidatePathsFromText parses prompt-declared paths', async () => {
  const repo = await makeRepo()

  const candidates = await extractCandidatePathsFromText(
    repo,
    'Update `./src/runtime/loop.ts` and inspect src/AGENTS.md before broad exploration.'
  )

  assert.ok(candidates.includes(resolve(repo, 'src/runtime/loop.ts')))
  assert.ok(candidates.includes(resolve(repo, 'src/AGENTS.md')))
})
