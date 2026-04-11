import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateUsageCostUsd,
  createUsageTracker,
  formatUsageProgressLine,
} from '../src/runtime/usage.ts'

test('usage tracker accumulates prompt/completion/cached tokens', () => {
  const tracker = createUsageTracker()

  const first = tracker.record({
    prompt_tokens: 120,
    completion_tokens: 30,
    cached_tokens: 20,
  })
  assert.equal(first.turn, 1)
  assert.equal(first.delta.prompt_tokens, 120)
  assert.equal(first.delta.completion_tokens, 30)
  assert.equal(first.delta.cached_tokens, 20)
  assert.equal(first.totals.total_tokens, 150)

  const second = tracker.record({
    prompt_tokens: 80,
    completion_tokens: 40,
    cached_tokens: null,
  })
  assert.equal(second.turn, 2)
  assert.equal(second.totals.prompt_tokens, 200)
  assert.equal(second.totals.completion_tokens, 70)
  assert.equal(second.totals.cached_tokens, 20)
  assert.equal(second.totals.total_tokens, 270)
})

test('formatUsageProgressLine prints delta and totals', () => {
  const tracker = createUsageTracker()
  const snapshot = tracker.record({
    prompt_tokens: 10,
    completion_tokens: 5,
    cached_tokens: 1,
  })

  const line = formatUsageProgressLine(snapshot)
  assert.match(line, /\[usage\]/)
  assert.match(line, /\+in 10/)
  assert.match(line, /\+out 5/)
  assert.match(line, /\+cached 1/)
  assert.match(line, /total in 10/)
})

test('calculateUsageCostUsd handles cached tokens as discounted input', () => {
  const cost = calculateUsageCostUsd(
    {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cached_tokens: 200,
      total_tokens: 1500,
    },
    {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cachedInputPerMillion: 0.25,
    },
  )

  const expected = ((800 * 2.5) + (200 * 0.25) + (500 * 10)) / 1_000_000
  assert.equal(Number(cost.toFixed(12)), Number(expected.toFixed(12)))
})
