/**
 * Integration: Progress artifact lifecycle (no LLM required).
 *
 * Exercises the full create → update → read lifecycle of .merlion/progress.md:
 *   1. ensureProgressArtifact creates the file with an initial objective.
 *   2. updateProgressArtifact merges done/next items correctly.
 *   3. A second update with a duplicate done item does NOT duplicate it.
 *   4. readProgressArtifact respects the maxTokens budget.
 *
 * Does NOT require an API key.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import {
  ensureProgressArtifact,
  updateProgressArtifact,
  readProgressArtifact,
} from '../../src/artifacts/progress.ts'

test('progress artifact: create, update, deduplicate, and read with budget', async () => {
  const sandbox = await makeSandbox()
  try {
    const OBJECTIVE = 'Build the Merlion agent runtime end-to-end'

    // ── Create ────────────────────────────────────────────────────────────────
    const initial = await ensureProgressArtifact(sandbox, OBJECTIVE)
    assert.match(initial.content, /Merlion Progress/, 'Template header must be present')
    assert.match(initial.content, new RegExp(OBJECTIVE), 'Objective must be set')

    // Verify the file was written to disk
    const rawFile = await readFile(join(sandbox, '.merlion', 'progress.md'), 'utf8')
    assert.match(rawFile, new RegExp(OBJECTIVE), 'File on disk must contain the objective')

    // ── First update ──────────────────────────────────────────────────────────
    const afterFirst = await updateProgressArtifact(sandbox, {
      done: ['Set up project structure', 'Implemented loop runtime'],
      next: ['Add tool budget', 'Write E2E tests'],
    })
    assert.match(afterFirst.content, /Set up project structure/, 'done item must appear')
    assert.match(afterFirst.content, /Implemented loop runtime/, 'done item must appear')
    assert.match(afterFirst.content, /Add tool budget/, 'next item must appear')
    assert.match(afterFirst.content, /Write E2E tests/, 'next item must appear')

    // ── Second update: deduplication ──────────────────────────────────────────
    const afterSecond = await updateProgressArtifact(sandbox, {
      done: ['Set up project structure'],    // already exists — must NOT be duplicated
      next: ['Deploy to production'],         // new item — must be added
    })
    const dupe = (afterSecond.content.match(/Set up project structure/g) ?? []).length
    assert.equal(dupe, 1, 'Duplicate done item must appear exactly once after merge')
    assert.match(afterSecond.content, /Deploy to production/, 'New next item must be added')
    assert.match(afterSecond.content, /Write E2E tests/, 'Pre-existing next item must be kept')

    // ── Read with token budget ────────────────────────────────────────────────
    const read = await readProgressArtifact(sandbox, { maxTokens: 50 })
    assert.ok(read.text.length > 0, 'readProgressArtifact must return non-empty text')
    // 50 tokens × 4 chars/token = 200 chars max (with truncation marker overhead)
    assert.ok(
      read.text.length <= 250,
      `Read result length (${read.text.length}) should be within budget`,
    )
    assert.ok(read.tokensEstimate > 0, 'Token estimate must be positive')
  } finally {
    await rmSandbox(sandbox)
  }
})
