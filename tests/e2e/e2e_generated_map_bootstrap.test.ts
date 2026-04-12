/**
 * Integration E2E: generated map bootstrap for existing repos without AGENTS files.
 *
 * Verifies:
 * 1) bootstrap creates `.merlion/maps` AGENTS artifacts when no project AGENTS exist.
 * 2) orientation includes AGENTS section from generated map fallback.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import { ensureGeneratedAgentsMaps } from '../../src/artifacts/agents_bootstrap.ts'
import { buildOrientationContext } from '../../src/context/orientation.ts'

test('bootstrap generated map appears in orientation when project has no AGENTS.md', async () => {
  const sandbox = await makeSandbox()
  try {
    await mkdir(join(sandbox, '.git'), { recursive: true })
    await mkdir(join(sandbox, 'src', 'runtime'), { recursive: true })
    await writeFile(join(sandbox, 'src', 'runtime', 'loop.ts'), 'export const marker = true\n', 'utf8')

    const bootstrap = await ensureGeneratedAgentsMaps(sandbox)
    assert.equal(bootstrap.created, true)
    assert.equal(
      bootstrap.generatedFiles.some((x) => x.endsWith('/MERLION.md') || x.endsWith('/AGENTS.md')),
      true
    )

    const orientation = await buildOrientationContext(join(sandbox, 'src', 'runtime'))
    assert.match(orientation.text, /### AGENTS Guidance/)
    assert.match(orientation.text, /generated map/)
  } finally {
    await rmSandbox(sandbox)
  }
})
