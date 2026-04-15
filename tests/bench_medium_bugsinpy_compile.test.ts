import assert from 'node:assert/strict'
import test from 'node:test'

import {
  relevantCommandsNeedPytest,
  sanitizeRequirements,
} from '../scripts/bench_medium/bugsinpy/compile.ts'

test('sanitizeRequirements drops pkg-resources placeholder package', () => {
  assert.deepEqual(
    sanitizeRequirements([
      'pytest==7.0.0',
      'pkg-resources==0.0.0',
      'requests==2.0.0',
    ]),
    ['pytest==7.0.0', 'requests==2.0.0'],
  )
})

test('relevantCommandsNeedPytest detects pytest invocations', () => {
  assert.equal(relevantCommandsNeedPytest(['pytest -q tests/test_a.py']), true)
  assert.equal(relevantCommandsNeedPytest(['python -m unittest -q tests.test_a']), false)
})
