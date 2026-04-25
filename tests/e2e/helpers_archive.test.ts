import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunLoopResult } from '../../src/runtime/loop.ts'
import type { PromptObservabilitySnapshot } from '../../src/runtime/prompt_observability.ts'
import { summarizeToolSchema } from '../../src/runtime/prompt_observability.ts'
import { assertPromptObservabilityArchive, buildUsageArchivePayload } from './helpers.ts'

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
      { prompt_tokens: 210, completion_tokens: 20, cached_tokens: 0 },
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
  assert.deepEqual(payload.derived_totals, {
    uncached_prompt_tokens: 426,
    cached_prompt_ratio: 30 / 456,
    effective_input_tokens: 426,
    effective_total_tokens: 458,
    primary_metric: 'effective_total_tokens',
    primary_metric_value: 458,
    primary_metric_degraded_reason: null,
  })
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

test('E2E usage archive payload keeps degraded derived totals and prompt observability triage signals', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ])
  const promptObservability: PromptObservabilitySnapshot[] = [
    {
      turn: 1,
      estimated_input_tokens: 480,
      tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
      role_tokens: { system: 140, user: 40, assistant: 0, tool: 0 },
      role_delta_tokens: { system: 140, user: 40, assistant: 0, tool: 0 },
      stable_prefix_tokens: 0,
      stable_prefix_ratio: 0,
      stable_prefix_hash: null,
    },
    {
      turn: 2,
      estimated_input_tokens: 500,
      tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
      role_tokens: { system: 140, user: 42, assistant: 18, tool: 0 },
      role_delta_tokens: { system: 0, user: 2, assistant: 18, tool: 0 },
      stable_prefix_tokens: 455,
      stable_prefix_ratio: 0.91,
      stable_prefix_hash: 'stable-two',
    },
    {
      turn: 3,
      estimated_input_tokens: 504,
      tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
      role_tokens: { system: 140, user: 46, assistant: 18, tool: 0 },
      role_delta_tokens: { system: 0, user: 4, assistant: 0, tool: 0 },
      stable_prefix_tokens: 96,
      stable_prefix_ratio: 0.19,
      stable_prefix_hash: 'unstable-three',
    },
  ]
  const result: RunLoopResult = {
    terminal: 'completed',
    finalText: 'done',
    state: {
      items: [],
      turnCount: 3,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      nudgeCount: 0,
    },
  }

  const payload = buildUsageArchivePayload({
    scenario: 'Cache Drift',
    task: 'Investigate prompt stability.',
    cwd: '/tmp/merlion-test',
    result,
    model: 'test-model',
    baseURL: 'https://example.test/v1',
    usageSamples: [
      { prompt_tokens: 320, completion_tokens: 30, cached_tokens: 200 },
      { prompt_tokens: 340, completion_tokens: 28, cached_tokens: null },
    ],
    totals: {
      prompt_tokens: 660,
      completion_tokens: 58,
      cached_tokens: 200,
      total_tokens: 718,
    },
    toolSchema,
    promptObservability,
    usageRates: {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cachedInputPerMillion: 0.25,
    },
  })

  assert.equal(payload.derived_totals.primary_metric, 'estimated_cost_usd')
  assert.equal(payload.derived_totals.primary_metric_degraded_reason, 'cached_tokens_unavailable')
  assert.equal(Number(payload.derived_totals.estimated_cost_usd!.toFixed(12)), 0.00223)
  assert.equal(Number(payload.derived_totals.primary_metric_value.toFixed(12)), 0.00223)
  assert.equal(payload.prompt_observability[1]?.stable_prefix_ratio, 0.91)
  assert.equal(payload.prompt_observability[2]?.stable_prefix_ratio, 0.19)
  assert.equal(
    payload.prompt_observability[1]?.tool_schema_tokens_estimate,
    payload.prompt_observability[2]?.tool_schema_tokens_estimate,
  )
})

test('prompt observability archive assertions summarize cache-first stability signals', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ])
  const payload = buildUsageArchivePayload({
    scenario: 'Archive Signals',
    task: 'Inspect cache-first prompt observability.',
    cwd: '/tmp/merlion-test',
    result: {
      terminal: 'completed',
      finalText: 'done',
      state: {
        items: [],
        turnCount: 2,
        maxOutputTokensRecoveryCount: 0,
        hasAttemptedReactiveCompact: false,
        nudgeCount: 0,
      },
    } satisfies RunLoopResult,
    model: 'test-model',
    baseURL: 'https://example.test/v1',
    usageSamples: [
      { prompt_tokens: 300, completion_tokens: 20, cached_tokens: 0 },
      { prompt_tokens: 320, completion_tokens: 18, cached_tokens: 80 },
    ],
    totals: {
      prompt_tokens: 620,
      completion_tokens: 38,
      cached_tokens: 80,
      total_tokens: 658,
    },
    toolSchema,
    promptObservability: [
      {
        turn: 1,
        estimated_input_tokens: 300,
        tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
        role_tokens: { system: 100, user: 20, assistant: 0, tool: 0 },
        role_delta_tokens: { system: 100, user: 20, assistant: 0, tool: 0 },
        stable_prefix_tokens: 0,
        stable_prefix_ratio: 0,
        stable_prefix_hash: null,
      },
      {
        turn: 2,
        estimated_input_tokens: 320,
        tool_schema_tokens_estimate: toolSchema.tool_schema_tokens_estimate,
        role_tokens: { system: 100, user: 20, assistant: 12, tool: 0 },
        role_delta_tokens: { system: 0, user: 0, assistant: 12, tool: 0 },
        stable_prefix_tokens: 280,
        stable_prefix_ratio: 0.875,
        stable_prefix_hash: 'stable-two',
      },
    ],
  })

  const summary = assertPromptObservabilityArchive(payload, {
    minSnapshots: 2,
    minStablePrefixTokens: 200,
    minStablePrefixRatio: 0.8,
  })

  assert.equal(summary.maxStablePrefixTokens, 280)
  assert.equal(summary.maxStablePrefixRatio, 0.875)
})
