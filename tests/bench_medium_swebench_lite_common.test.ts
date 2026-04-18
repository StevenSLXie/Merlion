import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRunToken, filterCases, loadAllCases, resolveDatasetCandidates } from '../scripts/bench_medium/swebench_lite/common.ts'
import { buildTaskPrompt } from '../scripts/bench_medium/swebench_lite/prepare.ts'

test('loadAllCases discovers seeded SWE-bench Lite cases', async () => {
  const cases = await loadAllCases()
  const ids = cases.map((item) => item.id)
  assert.ok(ids.includes('SWEL001_SYMPY_20590'))
  assert.ok(ids.includes('SWEL002_ASTROPY_14539'))
  assert.ok(ids.includes('SWEL_PSF_REQUESTS_1963'))
  const legacySympy = cases.find((item) => item.id === 'SWEL001_SYMPY_20590')
  const importedSympy = cases.find((item) => item.id === 'SWEL_SYMPY_SYMPY_20590')
  assert.equal(legacySympy?.status, 'deprecated')
  assert.equal(importedSympy?.status, 'seeded')
})

test('resolveDatasetCandidates keeps configured name and fallbacks', () => {
  const previous = process.env.MERLION_SWEBENCH_DATASET_NAME
  process.env.MERLION_SWEBENCH_DATASET_NAME = 'custom/split'
  try {
    assert.deepEqual(resolveDatasetCandidates(), [
      'custom/split',
      'princeton-nlp/SWE-bench_Lite',
      'SWE-bench/SWE-bench_Lite',
    ])
  } finally {
    if (previous == null) delete process.env.MERLION_SWEBENCH_DATASET_NAME
    else process.env.MERLION_SWEBENCH_DATASET_NAME = previous
  }
})

test('buildTaskPrompt embeds issue body and hints', async () => {
  const spec = (await loadAllCases())[0]!
  const prompt = buildTaskPrompt(spec, {
    instance_id: spec.instance_id,
    repo: 'sympy/sympy',
    base_commit: 'abc123',
    problem_statement: 'Fix a sympify edge case.',
    hints_text: 'Touch as little code as possible.',
    issue_url: 'https://example.test/issue',
  })
  assert.match(prompt, /<issue>/)
  assert.match(prompt, /Fix a sympify edge case/)
  assert.match(prompt, /Touch as little code as possible/)
})

test('filterCases supports comma-separated case filters', async () => {
  const cases = await loadAllCases()
  const filtered = filterCases(cases, 'sympy__sympy-20590,psf/requests')
  assert.ok(filtered.some((item) => item.id === 'SWEL_SYMPY_SYMPY_20590'))
  assert.ok(!filtered.some((item) => item.id === 'SWEL001_SYMPY_20590'))
  assert.ok(filtered.some((item) => item.instance_id === 'psf__requests-1963'))
})

test('filterCases excludes deprecated cases by default', async () => {
  const cases = await loadAllCases()
  const filtered = filterCases(cases)
  assert.ok(!filtered.some((item) => item.id === 'SWEL002_ASTROPY_14539'))
})

test('buildRunToken appends pid unless overridden', () => {
  assert.equal(
    buildRunToken({ date: new Date(2026, 3, 17, 8, 2, 33), pid: 4321 }),
    '20260417-080233-4321',
  )
  assert.equal(buildRunToken({ override: 'manual-run' }), 'manual-run')
})
