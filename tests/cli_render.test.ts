import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatAssistantResponseEvent,
  formatToolResultEvent,
  formatToolStartEvent,
  formatTurnStartEvent,
} from '../src/cli/render.ts'

test('formatTurnStartEvent prints turn label', () => {
  const line = formatTurnStartEvent({ turn: 3 })
  assert.match(line, /\[turn 3\]/)
  assert.match(line, /requesting model/i)
})

test('formatAssistantResponseEvent prints tool request count', () => {
  const line = formatAssistantResponseEvent({
    turn: 2,
    finish_reason: 'tool_calls',
    tool_calls_count: 2,
  })
  assert.match(line, /\[turn 2\]/)
  assert.match(line, /requested 2 tool/)
})

test('formatTool start/result events', () => {
  const start = formatToolStartEvent({
    index: 1,
    total: 2,
    name: 'read_file',
    summary: 'path=README.md',
  })
  assert.match(start, /\[tool 1\/2\]/)
  assert.match(start, /read_file/)

  const done = formatToolResultEvent({
    index: 1,
    total: 2,
    name: 'read_file',
    isError: false,
    durationMs: 42,
  })
  assert.match(done, /\[tool 1\/2\]/)
  assert.match(done, /ok/)
  assert.match(done, /42ms/)
})
