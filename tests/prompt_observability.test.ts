import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  createPromptObservabilityTracker,
  createPromptObservabilityTrackerWithToolSchema,
  estimateTokensFromChars,
  summarizeToolSchema,
  withResponseBoundaryPromptObservability,
} from '../src/runtime/prompt_observability.ts'
import { createExternalUserItem, createFunctionCallOutputItem, createSystemItem, messagesToItems } from '../src/runtime/items.ts'

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

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
  assert.equal(first.tool_schema_hash, null)
  assert.equal(first.schema_change_reason, null)
  assert.equal(first.overlay_tokens_estimate, 0)
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
  assert.equal(second.tool_schema_hash, null)
  assert.equal(second.overlay_tokens_estimate, 0)
  assert.equal(second.role_tokens.tool > 0, true)
  assert.equal(second.role_delta_tokens.tool > 0, true)
})

test('prompt observability includes stable tool schema tokens across turns', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ])
  const tracker = createPromptObservabilityTrackerWithToolSchema(toolSchema.tool_schema_serialized)

  const first = tracker.record(1, messagesToItems([{ role: 'system', content: 'sys' }]))
  assert.equal(first.tool_schema_tokens_estimate, toolSchema.tool_schema_tokens_estimate)
  assert.equal(first.tool_schema_hash, shortHash(toolSchema.tool_schema_serialized))
  assert.equal(first.stable_prefix_tokens, 0)

  const second = tracker.record(2, messagesToItems([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]))
  assert.equal(second.tool_schema_tokens_estimate, first.tool_schema_tokens_estimate)
  assert.equal(second.stable_prefix_tokens >= second.tool_schema_tokens_estimate, true)
  assert.equal(typeof second.stable_prefix_hash, 'string')
  assert.equal(second.tool_schema_hash, first.tool_schema_hash)
})

test('prompt observability exposes cache-instability signals without changing tool schema accounting', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ])
  const tracker = createPromptObservabilityTrackerWithToolSchema(toolSchema.tool_schema_serialized)

  tracker.record(1, messagesToItems([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read hello.txt' },
  ]))
  const stable = tracker.record(2, messagesToItems([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read hello.txt' },
    { role: 'assistant', content: 'hello' },
  ]))
  const unstable = tracker.record(3, messagesToItems([
    { role: 'system', content: 'sys updated' },
    { role: 'user', content: 'read hello.txt' },
    { role: 'assistant', content: 'hello' },
  ]))

  assert.equal(stable.tool_schema_tokens_estimate, unstable.tool_schema_tokens_estimate)
  assert.equal(unstable.estimated_input_tokens >= stable.estimated_input_tokens, true)
  assert.equal(stable.stable_prefix_ratio > unstable.stable_prefix_ratio, true)
  assert.equal(unstable.stable_prefix_tokens < stable.stable_prefix_tokens, true)
})

test('prompt observability excludes overlay tokens from stable prefix math', () => {
  const toolSchema = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ])
  const tracker = createPromptObservabilityTracker()

  const first = tracker.record(1, {
    stablePrefixItems: [createSystemItem('sys', 'static')],
    overlayItems: [createSystemItem('Execution charter for this turn:\n- stay read-only', 'runtime')],
    transcriptItems: [createExternalUserItem('read hello.txt')],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    schemaChangeReason: 'initial_epoch',
  })
  const second = tracker.record(2, {
    stablePrefixItems: [createSystemItem('sys', 'static')],
    overlayItems: [createSystemItem('Execution charter for this turn:\n- stay read-only and mention exact output', 'runtime')],
    transcriptItems: [createExternalUserItem('read hello.txt')],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    schemaChangeReason: null,
  })

  assert.equal(first.overlay_tokens_estimate > 0, true)
  assert.equal(second.overlay_tokens_estimate > first.overlay_tokens_estimate, true)
  assert.equal(second.tool_schema_hash, shortHash(toolSchema.tool_schema_serialized))
  assert.equal(second.stable_prefix_ratio, 1)
  assert.equal(second.stable_prefix_tokens, estimateTokensFromChars('systemstaticsys'.length) + estimateTokensFromChars('userexternalread hello.txt'.length) + toolSchema.tool_schema_tokens_estimate)
})

test('prompt observability records schema-change reasons from the real tool schema', () => {
  const analysisTools = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ])
  const verificationTools = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ])
  const tracker = createPromptObservabilityTracker()
  const input = {
    stablePrefixItems: [createSystemItem('sys', 'static')],
    overlayItems: [],
    transcriptItems: [createExternalUserItem('verify the fix')],
  }

  tracker.record(1, {
    ...input,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    schemaChangeReason: 'initial_epoch',
  })
  const stable = tracker.record(2, {
    ...input,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    schemaChangeReason: null,
  })
  const switched = tracker.record(3, {
    ...input,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'bash',
        description: 'Run a shell command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ],
    schemaChangeReason: 'phase_switch',
  })

  assert.equal(stable.tool_schema_hash, shortHash(analysisTools.tool_schema_serialized))
  assert.equal(switched.tool_schema_hash, shortHash(verificationTools.tool_schema_serialized))
  assert.equal(switched.schema_change_reason, 'phase_switch')
  assert.equal(switched.stable_prefix_tokens < stable.stable_prefix_tokens, true)
})

test('tool schema observability summary matches serialized prompt accounting inputs', () => {
  const summary = summarizeToolSchema([
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'search',
      description: 'Search within files.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
    },
  ])

  assert.equal(summary.tool_count, 2)
  assert.equal(summary.tool_schema_serialized.length, summary.tool_schema_serialized_chars)
  assert.equal(summary.tool_schema_tokens_estimate, Math.ceil(summary.tool_schema_serialized_chars / 4))
  assert.match(summary.tool_schema_serialized, /"name":"read_file"/)
  assert.match(summary.tool_schema_serialized, /"name":"search"/)
})

test('tool schema observability summary canonicalizes equivalent tool registries', () => {
  const first = summarizeToolSchema([
    {
      name: 'zeta_tool',
      description: 'Inspect the requested target.',
      parameters: {
        type: 'object',
        required: ['target', 'mode'],
        properties: {
          target: { type: 'string' },
          mode: { enum: ['write', 'read'], type: 'string' },
        },
      },
    },
    {
      name: 'alpha_tool',
      description: 'Read the requested path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          format: { type: ['string', 'number', 'boolean', 'null'], enum: ['json', 7, true, '7', null] },
        },
        required: ['format', 'path'],
      },
    },
  ])
  const second = summarizeToolSchema([
    {
      name: 'alpha_tool',
      description: 'Read the requested path.',
      parameters: {
        required: ['path', 'format'],
        properties: {
          format: { enum: ['7', true, null, 'json', 7], type: ['boolean', 'null', 'number', 'string'] },
          path: { type: 'string' },
        },
        type: 'object',
      },
    },
    {
      name: 'zeta_tool',
      description: 'Inspect the requested target.',
      parameters: {
        properties: {
          mode: { type: 'string', enum: ['read', 'write'] },
          target: { type: 'string' },
        },
        type: 'object',
        required: ['mode', 'target'],
      },
    },
  ])

  assert.equal(first.tool_schema_serialized, second.tool_schema_serialized)
  assert.equal(first.tool_schema_tokens_estimate, second.tool_schema_tokens_estimate)
  assert.match(first.tool_schema_serialized, /"name":"alpha_tool".*"name":"zeta_tool"/)
  assert.match(first.tool_schema_serialized, /"required":\["format","path"\]/)
  assert.match(first.tool_schema_serialized, /"enum":\[true,null,7,"7","json"\]/)
  assert.match(first.tool_schema_serialized, /"type":\["boolean","null","number","string"\]/)
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
