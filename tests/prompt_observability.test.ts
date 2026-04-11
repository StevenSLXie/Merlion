import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../src/types.ts'
import { createPromptObservabilityTracker } from '../src/runtime/prompt_observability.ts'

test('prompt observability tracks role tokens and stable prefix hash', () => {
  const tracker = createPromptObservabilityTracker()

  const turn1Messages: ChatMessage[] = [
    { role: 'system', content: 'You are Merlion.' },
    { role: 'user', content: 'hello' }
  ]
  const first = tracker.record(1, turn1Messages)
  assert.equal(first.turn, 1)
  assert.equal(first.stable_prefix_tokens, 0)
  assert.equal(first.stable_prefix_hash, null)
  assert.equal(first.role_tokens.system > 0, true)
  assert.equal(first.role_tokens.user > 0, true)
  assert.equal(first.role_tokens.assistant, 0)
  assert.equal(first.role_tokens.tool, 0)

  const turn2Messages: ChatMessage[] = [
    { role: 'system', content: 'You are Merlion.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'search', arguments: '{"pattern":"x"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'search', content: 'src/index.ts:1:export const x = 1' },
    { role: 'assistant', content: 'done' }
  ]
  const second = tracker.record(2, turn2Messages)
  assert.equal(second.turn, 2)
  assert.equal(second.stable_prefix_tokens > 0, true)
  assert.equal(typeof second.stable_prefix_hash, 'string')
  assert.equal(second.role_tokens.tool > 0, true)
  assert.equal(second.role_delta_tokens.tool > 0, true)
})
