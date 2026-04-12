/**
 * Integration E2E: path guidance lifecycle (no LLM required).
 *
 * Verifies:
 * 1) path guidance loads AGENTS.md along root -> target chain.
 * 2) already-loaded AGENTS files are not re-injected.
 * 3) a different target path appends only newly discovered AGENTS files.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import { buildPathGuidanceDelta, createPathGuidanceState } from '../../src/context/path_guidance.ts'

test('path guidance lifecycle: chain load, dedup, incremental append', async () => {
  const sandbox = await makeSandbox()
  try {
    await mkdir(join(sandbox, 'src', 'runtime'), { recursive: true })
    await mkdir(join(sandbox, 'src', 'tools'), { recursive: true })

    await writeFile(join(sandbox, 'AGENTS.md'), '# root\n', 'utf8')
    await writeFile(join(sandbox, 'src', 'AGENTS.md'), '# src\n', 'utf8')
    await writeFile(join(sandbox, 'src', 'runtime', 'AGENTS.md'), '# runtime\n', 'utf8')
    await writeFile(join(sandbox, 'src', 'tools', 'AGENTS.md'), '# tools\n', 'utf8')

    const state = createPathGuidanceState()

    const first = await buildPathGuidanceDelta(
      sandbox,
      ['./src/runtime/loop.ts'],
      state,
      { totalTokens: 1000, perFileTokens: 200, maxFiles: 10 }
    )

    assert.deepEqual(first.loadedFiles, [
      'AGENTS.md',
      'src/AGENTS.md',
      'src/runtime/AGENTS.md',
    ])
    assert.match(first.text, /## AGENTS\.md/)
    assert.match(first.text, /## src\/AGENTS\.md/)
    assert.match(first.text, /## src\/runtime\/AGENTS\.md/)

    const second = await buildPathGuidanceDelta(sandbox, ['./src/runtime/loop.ts'], state)
    assert.equal(second.loadedFiles.length, 0)
    assert.equal(second.text, '')

    const third = await buildPathGuidanceDelta(sandbox, ['./src/tools/index.ts'], state)
    assert.deepEqual(third.loadedFiles, ['src/tools/AGENTS.md'])
    assert.match(third.text, /## src\/tools\/AGENTS\.md/)
  } finally {
    await rmSandbox(sandbox)
  }
})
