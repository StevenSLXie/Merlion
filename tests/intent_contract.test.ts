import test from 'node:test'
import assert from 'node:assert/strict'

import { buildIntentContract } from '../src/runtime/intent_contract.ts'

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

