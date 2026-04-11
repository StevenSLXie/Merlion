import test from 'node:test'
import assert from 'node:assert/strict'

import { createTuiFrame } from '../src/cli/tui_frame.ts'

test('createTuiFrame renders header body and status sections', () => {
  const frame = createTuiFrame({
    width: 80,
    height: 20,
    title: 'MERLION',
    subtitle: 'model qwen',
    status: 'status · turn 1',
    bodyLines: ['line a', 'line b']
  })

  assert.match(frame, /╔/)
  assert.match(frame, /MERLION/)
  assert.match(frame, /model qwen/)
  assert.match(frame, /line a/)
  assert.match(frame, /status · turn 1/)
})

test('createTuiFrame keeps only recent body lines', () => {
  const frame = createTuiFrame({
    width: 80,
    height: 18,
    title: 'T',
    subtitle: 'S',
    status: 'ok',
    bodyLines: Array.from({ length: 20 }, (_, i) => `row-${String(i + 1).padStart(2, '0')}`)
  })

  assert.match(frame, /row-20/)
  assert.equal(frame.includes('row-01'), false)
})
