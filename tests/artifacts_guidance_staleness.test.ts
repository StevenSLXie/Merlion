import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { detectPotentialStaleGuidance } from '../src/artifacts/guidance_staleness.ts'
import { AUTO_BEGIN, AUTO_END, MANUAL_BEGIN, MANUAL_END } from '../src/artifacts/agents_auto.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-guidance-stale-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src', 'runtime'), { recursive: true })
  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const loop = true\n', 'utf8')
  return root
}

function manualGuidance(): string {
  return [
    '# MERLION Guidance',
    '',
    MANUAL_BEGIN,
    '## Purpose',
    '- Runtime scope.',
    MANUAL_END,
    '',
    AUTO_BEGIN,
    '## LastUpdated',
    '- 2026-04-10',
    AUTO_END,
    ''
  ].join('\n')
}

test('detects stale guidance when code changed after manual guidance update', async () => {
  const repo = await makeRepo()
  const guidancePath = join(repo, 'src', 'MERLION.md')

  await writeFile(guidancePath, manualGuidance(), 'utf8')
  await utimes(guidancePath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  await writeFile(join(repo, 'src', 'runtime', 'loop.ts'), 'export const loop = false\n', 'utf8')

  const hints = await detectPotentialStaleGuidance(repo, ['src/runtime/loop.ts'])
  assert.equal(hints.length > 0, true)
  assert.equal(hints.some((hint) => hint.guidanceFile === 'src/MERLION.md'), true)
})

test('does not warn when guidance file itself changed in the same batch', async () => {
  const repo = await makeRepo()
  const guidancePath = join(repo, 'src', 'MERLION.md')

  await writeFile(guidancePath, manualGuidance(), 'utf8')
  await writeFile(join(repo, 'src', 'runtime', 'loop.ts'), 'export const loop = false\n', 'utf8')

  const hints = await detectPotentialStaleGuidance(repo, ['src/runtime/loop.ts', 'src/MERLION.md'])
  assert.equal(hints.length, 0)
})
