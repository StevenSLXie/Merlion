import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  computePythonPath,
  loadAllCases,
  readBugInfo,
  splitBugList,
} from '../scripts/bench_medium/bugsinpy/common.ts'

test('loadAllCases discovers seeded BugsInPy cases', async () => {
  const cases = await loadAllCases()
  assert.deepEqual(
    cases.map((item) => item.id),
    ['BIP001_THEFUCK_1', 'BIP002_THEFUCK_2', 'BIP003_THEFUCK_3'],
  )
  assert.equal(cases[0]?.project, 'thefuck')
  assert.equal(cases[0]?.status, 'validated')
})

test('splitBugList ignores blanks', () => {
  assert.deepEqual(splitBugList('a;; b ; ;c'), ['a', 'b', 'c'])
})

test('readBugInfo parses pythonpath and test_file entries', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'merlion-bip-info-'))
  await writeFile(join(repoDir, 'bugsinpy_bug.info'), [
    'pythonpath="src;lib"',
    'test_file="tests/test_one.py;tests/test_two.py"',
  ].join('\n'))
  const bugInfo = await readBugInfo(repoDir)
  assert.deepEqual(bugInfo.pythonpathEntries, ['src', 'lib'])
  assert.deepEqual(bugInfo.testFiles, ['tests/test_one.py', 'tests/test_two.py'])
})

test('computePythonPath resolves bug-info entries relative to checkout', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'merlion-bip-path-'))
  await mkdir(join(repoDir, 'src'))
  await mkdir(join(repoDir, 'lib'))
  await writeFile(join(repoDir, 'bugsinpy_bug.info'), 'pythonpath="src;lib"\n')
  const bugInfo = await readBugInfo(repoDir)
  const pythonPath = computePythonPath(repoDir, bugInfo)
  assert.equal(pythonPath, `${join(repoDir, 'src')}:${join(repoDir, 'lib')}`)
})
