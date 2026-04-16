import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyResult } from '../scripts/bench_medium/bugsinpy/analyze_runs.ts'

test('classifyResult maps compile failures to environment bucket', () => {
  const result = classifyResult({
    case_id: 'A',
    project: 'thefuck',
    bug_id: 1,
    status: 'failed',
    failure_reason: 'compile failed',
  })
  assert.equal(result.bucket, 'environment')
})

test('classifyResult maps regression failures after agent to regression_after_fix bucket', () => {
  const result = classifyResult({
    case_id: 'B',
    project: 'thefuck',
    bug_id: 2,
    status: 'failed',
    failure_reason: 'regression failed',
  })
  assert.equal(result.bucket, 'regression_after_fix')
})
