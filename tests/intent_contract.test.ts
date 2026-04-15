import test from 'node:test'
import assert from 'node:assert/strict'

import { buildIntentContract, extractExplicitTargetPaths } from '../src/runtime/intent_contract.ts'

test('buildIntentContract captures objective and explicit constraints', () => {
  const contract = buildIntentContract('把颜色改成淡黄色，不要改结构，先别发布。')
  assert.ok(contract)
  assert.match(contract ?? '', /Primary objective:/)
  assert.match(contract ?? '', /不要改结构/)
  assert.match(contract ?? '', /先别发布/)
  assert.match(contract ?? '', /Guardrail:/)
})

test('buildIntentContract returns null for empty prompt', () => {
  assert.equal(buildIntentContract('   '), null)
})

test('extractExplicitTargetPaths finds explicit file paths from prompt text', () => {
  const paths = extractExplicitTargetPaths(
    'Update `fixture/src/auth.js`, then adjust fixture/tests/auth.test.js. Do not touch docs.'
  )
  assert.deepEqual(paths, [
    'fixture/src/auth.js',
    'fixture/tests/auth.test.js',
  ])
})

test('buildIntentContract includes explicit target paths and path-first rule', () => {
  const contract = buildIntentContract(
    'Please update `src/runtime/loop.ts` and src/tools/builtin/read_file.ts. Do not scan the whole repo first.'
  )
  assert.ok(contract)
  assert.match(contract ?? '', /Explicit target paths from user:/)
  assert.match(contract ?? '', /src\/runtime\/loop\.ts/)
  assert.match(contract ?? '', /src\/tools\/builtin\/read_file\.ts/)
  assert.match(contract ?? '', /Path-first rule:/)
})
