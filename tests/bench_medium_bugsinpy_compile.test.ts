import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getVenvBootstrapCommands,
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

test('sanitizeRequirements rewrites self git dependency to local editable install', () => {
  assert.deepEqual(
    sanitizeRequirements(
      [
        '-e git+https://github.com/nvbn/thefuck@2ced7a7f33ae0bec3ffc7a43ce95330bdf6cfcb9#egg=thefuck',
        'pytest==7.0.0',
      ],
      '/tmp/workspace/thefuck',
    ),
    ['-e .', 'pytest==7.0.0'],
  )
})

test('relevantCommandsNeedPytest detects pytest invocations', () => {
  assert.equal(relevantCommandsNeedPytest(['pytest -q tests/test_a.py']), true)
  assert.equal(relevantCommandsNeedPytest(['python -m unittest -q tests.test_a']), false)
})

test('getVenvBootstrapCommands bootstraps pip tooling inside the created env', () => {
  assert.deepEqual(
    getVenvBootstrapCommands('/tmp/case/env/bin/python'),
    [
      '/tmp/case/env/bin/python -m ensurepip --upgrade',
    ],
  )
})
