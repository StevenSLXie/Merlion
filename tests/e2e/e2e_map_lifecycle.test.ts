/**
 * Integration: Map write pipeline (no LLM required).
 *
 * Covers the new semantic sections introduced in the orientation overhaul:
 *   1. codebase_index — "Directory Summary" section with inferred purpose lines.
 *   2. codebase_index — "Guidance Scopes" section lists MERLION.md / AGENTS.md files.
 *   3. progress_auto  — commit signal writes only the commit line, not a redundant
 *                       "Changed files" line.
 *   4. progress_auto  — no-commit signal writes only the "Changed files" line.
 *   5. guidance_staleness — detects stale guidance when code changes after manual map.
 *   6. guidance_staleness — no hint when guidance is newer than changed code.
 *   7. codebase_index — generated map appears in Guidance Scopes with generated label.
 *   8. codebase_index — changed files include latest git commit subject as note.
 *
 * Does NOT require an API key.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import test from 'node:test'

import { ensureCodebaseIndex, updateCodebaseIndexWithChangedFiles } from '../../src/artifacts/codebase_index.ts'
import { updateProgressFromRuntimeSignals } from '../../src/artifacts/progress_auto.ts'
import { detectPotentialStaleGuidance } from '../../src/artifacts/guidance_staleness.ts'
import { MANUAL_BEGIN, MANUAL_END, AUTO_BEGIN, AUTO_END } from '../../src/artifacts/agents_auto.ts'

async function makeGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-map-lifecycle-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
  await writeFile(join(root, 'tests', 'a.test.ts'), 'test("x", () => {})\n', 'utf8')
  execSync('git init', { cwd: root, stdio: 'ignore' })
  execSync('git config user.email "ci@example.com"', { cwd: root, stdio: 'ignore' })
  execSync('git config user.name "CI"', { cwd: root, stdio: 'ignore' })
  execSync('git add .', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' })
  return root
}

// ── 1. Directory Summary ───────────────────────────────────────────────────────
test('codebase_index includes Directory Summary with inferred purpose for known dirs', async () => {
  const root = await makeGitRepo()
  const artifact = await ensureCodebaseIndex(root)

  assert.match(artifact.content, /## Directory Summary/, 'Directory Summary section must be present')
  // "src" is a known dirname → should yield a non-trivial purpose line
  assert.match(artifact.content, /src:/, 'src directory must appear in Directory Summary')
  // "tests" is a known dirname
  assert.match(artifact.content, /tests:/, 'tests directory must appear in Directory Summary')
})

// ── 2. Guidance Scopes ────────────────────────────────────────────────────────
test('codebase_index lists project MERLION.md in Guidance Scopes', async () => {
  const root = await makeGitRepo()
  await writeFile(
    join(root, 'MERLION.md'),
    '# Root guidance\n\n## Purpose\n- Root scope.\n',
    'utf8',
  )
  await writeFile(
    join(root, 'src', 'AGENTS.md'),
    '# Src guidance\n\n## Purpose\n- Src scope.\n',
    'utf8',
  )

  const artifact = await ensureCodebaseIndex(root)

  assert.match(artifact.content, /## Guidance Scopes/, 'Guidance Scopes section must be present')
  assert.match(artifact.content, /\.: project MERLION\.md/, 'Root MERLION.md must appear as project scope')
  assert.match(artifact.content, /src: project AGENTS\.md/, 'src/AGENTS.md must appear as project scope')
})

// ── 3. progress_auto — commit path writes only commit line ────────────────────
test('auto-progress writes only the commit line when sawSuccessfulGitCommit is true', async () => {
  const root = await makeGitRepo()
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 42\n', 'utf8')
  execSync('git add src/index.ts', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "feat: raise x"', { cwd: root, stdio: 'ignore' })

  const result = await updateProgressFromRuntimeSignals(root, {
    changedPaths: ['src/index.ts'],
    sawSuccessfulGitCommit: true,
  })

  assert.equal(result.updated, true)
  const text = await readFile(join(root, '.merlion', 'progress.md'), 'utf8')
  assert.match(text, /Commit:.*feat: raise x/, 'commit line must appear in progress.md')
  assert.doesNotMatch(text, /Changed files:/, 'no redundant changed-files line when commit is present')
})

// ── 4. progress_auto — no-commit path writes only changed-files line ──────────
test('auto-progress writes only changed-files line when no commit signal', async () => {
  const root = await makeGitRepo()

  const result = await updateProgressFromRuntimeSignals(root, {
    changedPaths: ['src/index.ts'],
    sawSuccessfulGitCommit: false,
  })

  assert.equal(result.updated, true)
  const text = await readFile(join(root, '.merlion', 'progress.md'), 'utf8')
  assert.match(text, /Changed files: src\/index\.ts/, 'changed-files line must appear')
  assert.doesNotMatch(text, /Commit:/, 'no commit line when no commit signal')
})

// ── 5. guidance_staleness — detects stale manual map ─────────────────────────
test('guidance staleness detected when code file is newer than manual MERLION.md', async () => {
  const root = await makeGitRepo()
  const guidance = join(root, 'src', 'MERLION.md')
  const manualContent = [
    '# Guidance',
    MANUAL_BEGIN,
    '## Purpose',
    '- Src scope.',
    MANUAL_END,
    AUTO_BEGIN,
    '## LastUpdated',
    '- 2026-01-01',
    AUTO_END,
    '',
  ].join('\n')

  await writeFile(guidance, manualContent, 'utf8')
  // Back-date the guidance file so any code change is "newer"
  await utimes(guidance, new Date('2020-01-01'), new Date('2020-01-01'))

  // Change a source file (mtime will be "now", newer than guidance)
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 99\n', 'utf8')

  const hints = await detectPotentialStaleGuidance(root, ['src/index.ts'])
  assert.ok(hints.length > 0, 'should detect at least one stale guidance hint')
  assert.ok(
    hints.some((h) => h.guidanceFile === 'src/MERLION.md'),
    'hint must point to src/MERLION.md',
  )
})

// ── 6. guidance_staleness — no hint when guidance is up to date ───────────────
test('no staleness hint when guidance file is newer than changed code file', async () => {
  const root = await makeGitRepo()
  const guidance = join(root, 'src', 'MERLION.md')
  const manualContent = [
    '# Guidance',
    MANUAL_BEGIN,
    '## Purpose',
    '- Src scope.',
    MANUAL_END,
    AUTO_BEGIN,
    '## LastUpdated',
    '- 2026-04-01',
    AUTO_END,
    '',
  ].join('\n')

  // Back-date the code file so guidance is "newer"
  const codePath = join(root, 'src', 'index.ts')
  await writeFile(codePath, 'export const x = 1\n', 'utf8')
  await utimes(codePath, new Date('2020-01-01'), new Date('2020-01-01'))

  // Write guidance now (mtime = now, newer than code)
  await writeFile(guidance, manualContent, 'utf8')

  const hints = await detectPotentialStaleGuidance(root, ['src/index.ts'])
  assert.equal(hints.length, 0, 'no staleness hint when guidance is newer than changed code')
})

// ── 7. Guidance Scopes — generated maps listed with correct label ─────────────
test('codebase_index lists generated map in Guidance Scopes with "generated" label', async () => {
  const root = await makeGitRepo()
  // Place a generated map under .merlion/maps/src/
  await mkdir(join(root, '.merlion', 'maps', 'src'), { recursive: true })
  await writeFile(
    join(root, '.merlion', 'maps', 'src', 'MERLION.md'),
    '# Generated AGENTS Guidance\n\n## Scope\n- directory: src\n',
    'utf8',
  )

  const artifact = await ensureCodebaseIndex(root)

  assert.match(artifact.content, /## Guidance Scopes/, 'Guidance Scopes section must be present')
  assert.match(
    artifact.content,
    /src: generated MERLION\.md/,
    'generated map must appear with "generated" label',
  )
})

// ── 8. codebase_index — changed files carry git note after commit ─────────────
test('updateCodebaseIndexWithChangedFiles attaches git commit subject as note', async () => {
  const root = await makeGitRepo()
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 7\n', 'utf8')
  execSync('git add src/index.ts', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "fix: bump x to 7"', { cwd: root, stdio: 'ignore' })

  await updateCodebaseIndexWithChangedFiles(root, ['src/index.ts'])
  const text = await readFile(join(root, '.merlion', 'codebase_index.md'), 'utf8')

  assert.match(text, /## Recent Changed Files/, 'section must be present')
  assert.match(text, /fix: bump x to 7/, 'git commit subject must appear as change note')
})
