import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import test from 'node:test'

import { updateProgressFromRuntimeSignals } from '../src/artifacts/progress_auto.ts'

async function makeGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-progress-auto-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')

  execSync('git init', { cwd: root, stdio: 'ignore' })
  execSync('git config user.email "ci@example.com"', { cwd: root, stdio: 'ignore' })
  execSync('git config user.name "CI"', { cwd: root, stdio: 'ignore' })
  execSync('git add .', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' })

  return root
}

test('auto progress writes changed-file line without commit signal', async () => {
  const repo = await makeGitRepo()

  const out = await updateProgressFromRuntimeSignals(repo, {
    changedPaths: ['src/index.ts'],
    sawSuccessfulGitCommit: false,
  })

  assert.equal(out.updated, true)
  const text = await readFile(join(repo, '.merlion', 'progress.md'), 'utf8')
  assert.match(text, /Changed files: src\/index\.ts/)
  assert.doesNotMatch(text, /Commit:/)
})

test('auto progress appends commit summary when commit signal is true', async () => {
  const repo = await makeGitRepo()

  await writeFile(join(repo, 'src', 'index.ts'), 'export const x = 2\n', 'utf8')
  execSync('git add src/index.ts', { cwd: repo, stdio: 'ignore' })
  execSync('git commit -m "feat: bump x"', { cwd: repo, stdio: 'ignore' })

  const out = await updateProgressFromRuntimeSignals(repo, {
    changedPaths: ['src/index.ts'],
    sawSuccessfulGitCommit: true,
  })

  assert.equal(out.updated, true)
  const text = await readFile(join(repo, '.merlion', 'progress.md'), 'utf8')
  assert.match(text, /Changed files: src\/index\.ts/)
  assert.match(text, /Commit: .*feat: bump x/)
})
