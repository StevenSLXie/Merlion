import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunLoopResult } from '../../src/runtime/loop.ts'
import type { PromptObservabilitySnapshot } from '../../src/runtime/prompt_observability.ts'
import { summarizeToolSchema } from '../../src/runtime/prompt_observability.ts'
import { buildUsageArchivePayload } from './helpers.ts'

test('E2E usage archive payload includes tool schema and prompt floor observability fields', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'search',
      description: 'Search within files.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  ])
  const promptObservability: PromptObservabilitySnapshot[] = [
    {
      turn: 2,
      estimated_input_tokens: 456,
      tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
      role_tokens: { system: 100, user: 12, assistant: 24, tool: 18 },
      role_delta_tokens: { system: 0, user: 6, assistant: 10, tool: 8 },
      stable_prefix_tokens: 210,
      stable_prefix_ratio: 0.46,
      stable_prefix_hash: 'hash-two',
      runtime_response_id: 'rt_2',
      provider_response_id: 'resp_2',
      provider_finish_reason: 'stop',
    },
    {
      turn: 1,
      estimated_input_tokens: 420,
      tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
      role_tokens: { system: 100, user: 10, assistant: 0, tool: 0 },
      role_delta_tokens: { system: 100, user: 10, assistant: 0, tool: 0 },
      stable_prefix_tokens: 0,
      stable_prefix_ratio: 0,
      stable_prefix_hash: null,
    },
  ]
  const result: RunLoopResult = {
    terminal: 'completed',
    finalText: 'done',
    state: {
      items: [],
      turnCount: 2,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      nudgeCount: 0,
    },
  }

  const payload = buildUsageArchivePayload({
    scenario: 'E2E Read',
    task: 'Read README.md',
    cwd: '/tmp/merlion-test',
    result,
    model: 'test-model',
    baseURL: 'https://example.test/v1',
    usageSamples: [
      { prompt_tokens: 210, completion_tokens: 20, cached_tokens: null },
      { prompt_tokens: 246, completion_tokens: 12, cached_tokens: 30 },
    ],
    totals: {
      prompt_tokens: 456,
      completion_tokens: 32,
      cached_tokens: 30,
      total_tokens: 488,
    },
    toolSchema,
    promptObservability,
  })

  assert.equal(payload.scenario, 'e2e-read')
  assert.equal(payload.tool_count, 2)
  assert.equal(payload.tool_schema_serialized_chars, toolSchema.tool_schema_serialized_chars)
  assert.equal(payload.tool_schema_tokens_estimate, toolSchema.tool_schema_tokens_estimate)
  assert.equal(payload.turn_count, 2)
  assert.deepEqual(
    payload.prompt_observability.map((entry) => entry.turn),
    [1, 2],
  )
  assert.deepEqual(
    payload.prompt_observability.map((entry) => ({
      estimated_input_tokens: entry.estimated_input_tokens,
      tool_schema_tokens_estimate: entry.tool_schema_tokens_estimate,
      stable_prefix_tokens: entry.stable_prefix_tokens,
    })),
    [
      {
        estimated_input_tokens: 420,
        tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
        stable_prefix_tokens: 0,
      },
      {
        estimated_input_tokens: 456,
        tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
        stable_prefix_tokens: 210,
      },
    ],
  )
})
