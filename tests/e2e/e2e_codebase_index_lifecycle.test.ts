/**
 * Integration: Codebase index lifecycle (no LLM required).
 *
 * Exercises the full generate → update → read lifecycle of .merlion/codebase_index.md:
 *   1. ensureCodebaseIndex creates the file with top-level structure and file map.
 *   2. updateCodebaseIndexWithChangedFiles appends a "Recent Changed Files" section.
 *   3. Re-running update with a path already present deduplicates it (keeps once).
 *   4. readCodebaseIndex respects the maxTokens budget.
 *
 * Does NOT require an API key.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import {
  ensureCodebaseIndex,
  readCodebaseIndex,
  updateCodebaseIndexWithChangedFiles,
} from '../../src/artifacts/codebase_index.ts'

test('codebase index: generate, track changed files, deduplicate, and read with budget', async () => {
  const sandbox = await makeSandbox()
  try {
    // ── Generate ──────────────────────────────────────────────────────────────
    const initial = await ensureCodebaseIndex(sandbox)
    assert.match(initial.content, /Codebase Index/, 'Index must contain header')
    assert.match(initial.content, /Generated at:/, 'Index must contain generation timestamp')
    assert.match(initial.content, /Top-level/, 'Index must have Top-level section')

    // File must be on disk
    const rawFile = await readFile(join(sandbox, '.merlion', 'codebase_index.md'), 'utf8')
    assert.match(rawFile, /Codebase Index/, 'File on disk must contain header')

    // ── Track changed files ───────────────────────────────────────────────────
    await updateCodebaseIndexWithChangedFiles(sandbox, [
      'src/runtime/loop.ts',
      'src/tools/builtin/bash.ts',
    ])
    const afterFirst = await readFile(join(sandbox, '.merlion', 'codebase_index.md'), 'utf8')
    assert.match(afterFirst, /Recent Changed Files/, '"Recent Changed Files" section must appear')
    assert.match(afterFirst, /changed: src\/runtime\/loop\.ts — /, 'First changed file must appear')
    assert.match(afterFirst, /changed: src\/tools\/builtin\/bash\.ts — /, 'Second changed file must appear')

    // ── Deduplication ─────────────────────────────────────────────────────────
    await updateCodebaseIndexWithChangedFiles(sandbox, [
      'src/runtime/loop.ts',  // already tracked — must not appear twice
    ])
    const afterSecond = await readFile(join(sandbox, '.merlion', 'codebase_index.md'), 'utf8')
    const occurrences = (afterSecond.match(/src\/runtime\/loop\.ts/g) ?? []).length
    assert.equal(occurrences, 1, 'Duplicate path must appear exactly once after merge')
    assert.match(
      afterSecond,
      /src\/tools\/builtin\/bash\.ts/,
      'Non-duplicate path must still be present',
    )

    // ── Read with token budget ────────────────────────────────────────────────
    const read = await readCodebaseIndex(sandbox, { maxTokens: 50 })
    assert.ok(read.text.length > 0, 'readCodebaseIndex must return non-empty text')
    assert.ok(
      read.text.length <= 250,
      `Read result length (${read.text.length}) should be within budget`,
    )
    assert.ok(read.tokensEstimate > 0, 'Token estimate must be positive')
    assert.ok(read.truncated, 'Result must be marked truncated when under tight budget')
  } finally {
    await rmSandbox(sandbox)
  }
})
