import assert from 'node:assert/strict'
import test from 'node:test'

import { applyToolResultBudget } from '../src/runtime/budget.ts'

test('applyToolResultBudget keeps short content intact', () => {
  const input = 'hello\nworld'
  const out = applyToolResultBudget(input, { maxChars: 1000, maxLines: 100 })
  assert.equal(out.truncated, false)
  assert.equal(out.content, input)
})

test('applyToolResultBudget truncates by line count', () => {
  const input = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
  const out = applyToolResultBudget(input, { maxChars: 100000, maxLines: 120 })
  assert.equal(out.truncated, true)
  assert.match(out.content, /truncated .* lines/)
})

test('applyToolResultBudget truncates by char count', () => {
  const input = 'x'.repeat(10000)
  const out = applyToolResultBudget(input, { maxChars: 1000, maxLines: 20000 })
  assert.equal(out.truncated, true)
  assert.match(out.content, /truncated .* chars/)
  assert.equal(out.content.length <= 1200, true)
})
