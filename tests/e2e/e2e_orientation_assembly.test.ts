/**
 * Integration: Orientation context assembly (no LLM required).
 *
 * Calls buildOrientationContext() against a real sandbox directory and
 * verifies that:
 *   1. All three sections (AGENTS, Progress, Codebase Index) are assembled.
 *   2. AGENTS.md content appears in the output text.
 *   3. Section metadata is accurate.
 *   4. Token estimate fits within the default budget.
 *   5. Side effects: progress.md and codebase_index.md are created on disk.
 *
 * Does NOT require an API key — runs as part of the E2E suite for filesystem
 * integration coverage.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import { buildOrientationContext } from '../../src/context/orientation.ts'

test('buildOrientationContext assembles all three sections and creates artifact files', async () => {
  const sandbox = await makeSandbox()
  try {
    const AGENTS_CONTENT = 'Never commit secrets to the repository.'
    await writeFile(
      join(sandbox, 'AGENTS.md'),
      `# Security Guidelines\n\n${AGENTS_CONTENT}\n`,
      'utf8',
    )

    const result = await buildOrientationContext(sandbox)

    // ── Text content ─────────────────────────────────────────────────────────
    assert.ok(result.text.length > 0, 'Orientation text must be non-empty')
    assert.match(result.text, /AGENTS Guidance/, 'Must include AGENTS section header')
    assert.match(result.text, /Progress Snapshot/, 'Must include Progress section header')
    assert.match(result.text, /Codebase Index/, 'Must include Codebase Index section header')
    assert.match(
      result.text,
      new RegExp(AGENTS_CONTENT),
      'AGENTS.md content must appear in output',
    )

    // ── Section metadata ─────────────────────────────────────────────────────
    assert.equal(result.sections.length, 3, 'Must report metadata for 3 sections')

    const agentsSection = result.sections.find((s) => s.name === 'agents')!
    assert.ok(agentsSection, 'Must have agents section metadata')
    assert.ok(agentsSection.included, 'Agents section must be included')

    const progressSection = result.sections.find((s) => s.name === 'progress')!
    assert.ok(progressSection.included, 'Progress section must be included')

    const indexSection = result.sections.find((s) => s.name === 'index')!
    assert.ok(indexSection.included, 'Index section must be included')

    // ── Token budget ─────────────────────────────────────────────────────────
    assert.ok(result.tokensEstimate > 0, 'Token estimate must be positive')
    assert.ok(
      result.tokensEstimate <= 1200,
      `Token estimate (${result.tokensEstimate}) must not exceed default budget of 1200`,
    )

    // ── Side effects: artifact files created ─────────────────────────────────
    const progress = await readFile(join(sandbox, '.merlion', 'progress.md'), 'utf8')
    assert.match(progress, /Merlion Progress/, 'progress.md must be created with template header')

    const index = await readFile(join(sandbox, 'docs', 'codebase_index.md'), 'utf8')
    assert.match(index, /Codebase Index/, 'codebase_index.md must be created')
    assert.match(index, /Generated at:/, 'codebase_index.md must have a generation timestamp')
  } finally {
    await rmSandbox(sandbox)
  }
})
