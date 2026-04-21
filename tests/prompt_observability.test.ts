import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPromptObservabilityTracker,
  createPromptObservabilityTrackerWithToolSchema,
  withResponseBoundaryPromptObservability,
} from '../src/runtime/prompt_observability.ts'
import { createExternalUserItem, createFunctionCallOutputItem, createSystemItem, messagesToItems } from '../src/runtime/items.ts'

test('prompt observability tracks role tokens and stable prefix hash', () => {
  const tracker = createPromptObservabilityTracker()

  const turn1Messages = messagesToItems([
    { role: 'system', content: 'You are Merlion.' },
    { role: 'user', content: 'hello' }
  ])
  const first = tracker.record(1, turn1Messages)
  assert.equal(first.turn, 1)
  assert.equal(first.stable_prefix_tokens, 0)
  assert.equal(first.stable_prefix_hash, null)
  assert.equal(first.role_tokens.system > 0, true)
  assert.equal(first.role_tokens.user > 0, true)
  assert.equal(first.role_tokens.assistant, 0)
  assert.equal(first.role_tokens.tool, 0)

  const turn2Messages = messagesToItems([
    { role: 'system', content: 'You are Merlion.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'search', arguments: '{"pattern":"x"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'search', content: 'src/index.ts:1:export const x = 1' },
    { role: 'assistant', content: 'done' }
  ])
  const second = tracker.record(2, turn2Messages)
  assert.equal(second.turn, 2)
  assert.equal(second.stable_prefix_tokens > 0, true)
  assert.equal(typeof second.stable_prefix_hash, 'string')
  assert.equal(second.role_tokens.tool > 0, true)
  assert.equal(second.role_delta_tokens.tool > 0, true)
})

test('prompt observability includes stable tool schema tokens across turns', () => {
  const tracker = createPromptObservabilityTrackerWithToolSchema(JSON.stringify([
    { name: 'read_file', parameters: { type: 'object' } }
  ]))

  const first = tracker.record(1, messagesToItems([{ role: 'system', content: 'sys' }]))
  assert.equal(first.tool_schema_tokens_estimate > 0, true)
  assert.equal(first.stable_prefix_tokens, 0)

  const second = tracker.record(2, messagesToItems([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]))
  assert.equal(second.tool_schema_tokens_estimate, first.tool_schema_tokens_estimate)
  assert.equal(second.stable_prefix_tokens >= second.tool_schema_tokens_estimate, true)
  assert.equal(typeof second.stable_prefix_hash, 'string')
})

test('prompt observability can track stable prefix over item transcripts', () => {
  const tracker = createPromptObservabilityTracker()

  const first = tracker.record(1, [
    createSystemItem('sys', 'static'),
    createExternalUserItem('task'),
  ])
  assert.equal(first.role_tokens.system > 0, true)
  assert.equal(first.role_tokens.user > 0, true)

  const second = tracker.record(2, [
    createSystemItem('sys', 'static'),
    createExternalUserItem('task'),
    {
      kind: 'function_call',
      callId: 'call_1',
      name: 'read_file',
      argumentsText: '{"path":"src/app.ts"}',
    },
    createFunctionCallOutputItem('call_1', 'file content'),
  ])
  assert.equal(second.stable_prefix_tokens > 0, true)
  assert.equal(second.role_tokens.tool > 0, true)
})

test('prompt observability can attach response boundary correlation fields', () => {
  const tracker = createPromptObservabilityTracker()
  const snapshot = tracker.record(1, [
    createSystemItem('sys', 'static'),
    createExternalUserItem('task'),
  ])

  const correlated = withResponseBoundaryPromptObservability(snapshot, {
    runtimeResponseId: 'rt_1',
    providerResponseId: 'resp_1',
    finishReason: 'stop',
  })

  assert.equal(correlated.runtime_response_id, 'rt_1')
  assert.equal(correlated.provider_response_id, 'resp_1')
  assert.equal(correlated.provider_finish_reason, 'stop')
  assert.equal(correlated.stable_prefix_hash, snapshot.stable_prefix_hash)
})
