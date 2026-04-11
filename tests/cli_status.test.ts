import test from 'node:test'
import assert from 'node:assert/strict'

import { formatCliStatusLine } from '../src/cli/status.ts'
import type { UsageSnapshot } from '../src/runtime/usage.ts'

function snapshot(): UsageSnapshot {
  return {
    turn: 3,
    delta: {
      prompt_tokens: 1200,
      completion_tokens: 88,
      cached_tokens: 400,
      total_tokens: 1288
    },
    totals: {
      prompt_tokens: 9000,
      completion_tokens: 321,
      cached_tokens: 4200,
      total_tokens: 9321
    }
  }
}

test('formatCliStatusLine includes delta totals and cached ratio', () => {
  const line = formatCliStatusLine(snapshot())
  assert.match(line, /turn 3/)
  assert.match(line, /Δ in 1,200 out 88 cached 400/)
  assert.match(line, /Σ in 9,000 out 321 cached 4,200/)
  assert.match(line, /46\.7% input cached/)
})

test('formatCliStatusLine includes estimated cost when provided', () => {
  const line = formatCliStatusLine(snapshot(), 0.01234567)
  assert.match(line, /est \$0\.012346/)
})
