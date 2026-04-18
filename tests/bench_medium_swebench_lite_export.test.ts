import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import {
  buildPredictionRecord,
  collectGitPatch,
  writePredictionsFile,
} from '../scripts/bench_medium/swebench_lite/export_predictions.ts'

async function createGitRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), 'merlion-swel-repo-'))
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test User'])
  await writeFile(join(repoDir, 'tracked.txt'), 'before\n', 'utf8')
  run(['add', 'tracked.txt'])
  run(['commit', '-m', 'init'])
  return repoDir
}

test('collectGitPatch captures tracked edits and new files', async () => {
  const repoDir = await createGitRepo()
  await writeFile(join(repoDir, 'tracked.txt'), 'after\n', 'utf8')
  await mkdir(join(repoDir, 'docs'))
  await writeFile(join(repoDir, 'docs', 'note.txt'), 'hello\n', 'utf8')
  await mkdir(join(repoDir, '.merlion'))
  await writeFile(join(repoDir, '.merlion', 'trace.txt'), 'debug\n', 'utf8')
  await writeFile(join(repoDir, '>> 00:Read the relevant code in sessions.py around line 428 to understand the context before making the fix.'), 'oops\n', 'utf8')

  const collected = await collectGitPatch(repoDir)
  const patch = collected.patch

  assert.match(patch, /diff --git a\/tracked.txt b\/tracked.txt/)
  assert.match(patch, /diff --git a\/docs\/note.txt b\/docs\/note.txt/)
  assert.doesNotMatch(patch, /\.merlion\/trace.txt/)
  assert.doesNotMatch(patch, /Read the relevant code/)
  assert.deepEqual(collected.changed_paths.sort(), ['docs/note.txt', 'tracked.txt'])
  assert.equal(collected.excluded_paths.length, 1)
  assert.match(collected.excluded_paths[0] ?? '', /^>> 00:Read the relevant code/)
  assert.deepEqual(collected.suspect_artifacts, [])
})

test('writePredictionsFile emits JSONL records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merlion-swel-preds-'))
  const path = join(root, 'predictions.jsonl')
  await writePredictionsFile(path, [
    buildPredictionRecord('sympy__sympy-20590', 'merlion', 'diff --git a/x b/x'),
  ])
  const raw = await readFile(path, 'utf8')
  assert.match(raw, /"instance_id":"sympy__sympy-20590"/)
  assert.match(raw, /"model_patch":"diff --git a\/x b\/x"/)
})
