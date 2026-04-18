import test from 'node:test'
import assert from 'node:assert/strict'

import type { ToolCall } from '../src/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { executeToolCalls, partitionToolCalls } from '../src/runtime/executor.ts'

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  }
}

function tool(name: string, concurrencySafe: boolean): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    concurrencySafe,
    async execute() {
      return { content: `${name}:ok`, isError: false }
    }
  }
}

test('partition by concurrency safety', () => {
  const registry = new ToolRegistry()
  registry.register(tool('read_file', true))
  registry.register(tool('search', true))
  registry.register(tool('edit_file', false))

  const calls = [
    call('1', 'read_file'),
    call('2', 'search'),
    call('3', 'edit_file'),
    call('4', 'read_file')
  ]

  const batches = partitionToolCalls(calls, registry)
  assert.equal(batches.length, 3)
  assert.equal(batches[0]?.length, 2)
  assert.equal(batches[1]?.length, 1)
  assert.equal(batches[2]?.length, 1)
})

test('execute preserves output ordering', async () => {
  const registry = new ToolRegistry()
  registry.register({
    ...tool('t1', true),
    async execute() {
      await new Promise((r) => setTimeout(r, 50))
      return { content: 'first', isError: false }
    }
  })
  registry.register({
    ...tool('t2', true),
    async execute() {
      await new Promise((r) => setTimeout(r, 5))
      return { content: 'second', isError: false }
    }
  })

  const result = await executeToolCalls({
    toolCalls: [call('a', 't1'), call('b', 't2')],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 10
  })

  assert.deepEqual(
    result.map((m) => m.tool_call_id),
    ['a', 'b']
  )
  assert.deepEqual(
    result.map((m) => m.content),
    ['first', 'second']
  )
})

test('execute emits tool start/result hooks', async () => {
  const registry = new ToolRegistry()
  registry.register(tool('echo_a', true))
  registry.register(tool('echo_b', false))

  const events: string[] = []
  const calls = [call('a', 'echo_a'), call('b', 'echo_b')]

  const result = await executeToolCalls({
    toolCalls: calls,
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 10,
    onToolCallStart: ({ call, index, total }) => {
      events.push(`start:${index}/${total}:${call.function.name}`)
    },
    onToolCallResult: ({ call, index, total, durationMs }) => {
      events.push(`done:${index}/${total}:${call.function.name}:${durationMs >= 0}`)
    },
  })

  assert.equal(result.length, 2)
  assert.equal(events.some((e) => e.startsWith('start:1/2:echo_a')), true)
  assert.equal(events.some((e) => e.startsWith('start:2/2:echo_b')), true)
  assert.equal(events.some((e) => e.startsWith('done:1/2:echo_a:')), true)
  assert.equal(events.some((e) => e.startsWith('done:2/2:echo_b:')), true)
})

test('execute applies tool result budget truncation', async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: 'huge_output',
    description: 'returns huge text',
    parameters: { type: 'object', properties: {} },
    concurrencySafe: true,
    async execute() {
      return { content: 'x'.repeat(15000), isError: false }
    }
  })

  const result = await executeToolCalls({
    toolCalls: [call('h1', 'huge_output')],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 2,
  })

  assert.equal(result.length, 1)
  assert.match(result[0]?.content ?? '', /tool result truncated by budget/)
})

test('execute forwards tool ui payload to result hook', async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: 'edit_file',
    description: 'edit',
    parameters: { type: 'object', properties: {} },
    concurrencySafe: false,
    async execute() {
      return {
        content: 'Edited /tmp/a.ts (+1 -1)',
        isError: false,
        uiPayload: {
          kind: 'edit_diff' as const,
          path: '/tmp/a.ts',
          addedLines: 1,
          removedLines: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { type: 'remove' as const, text: 'old' },
                { type: 'add' as const, text: 'new' },
              ]
            }
          ]
        }
      }
    }
  })

  let seenPayloadKind: string | undefined
  await executeToolCalls({
    toolCalls: [call('edit-1', 'edit_file')],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 1,
    onToolCallResult: ({ uiPayload }) => {
      seenPayloadKind = uiPayload?.kind
    }
  })

  assert.equal(seenPayloadKind, 'edit_diff')
})

test('execute rejects non-object tool arguments before tool execution', async () => {
  const registry = new ToolRegistry()
  let executed = false
  registry.register({
    name: 'echo_tool',
    description: 'echo',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    concurrencySafe: true,
    async execute() {
      executed = true
      return { content: 'should not run', isError: false }
    }
  })

  const result = await executeToolCalls({
    toolCalls: [{
      id: 'bad-json',
      type: 'function',
      function: {
        name: 'echo_tool',
        arguments: '[]'
      }
    }],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 1,
  })

  assert.equal(executed, false)
  assert.match(result[0]?.content ?? '', /expected a strict JSON object/i)
})

test('execute rejects missing required or empty path arguments before tool execution', async () => {
  const registry = new ToolRegistry()
  let executed = 0
  registry.register({
    name: 'edit_file',
    description: 'edit',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    },
    concurrencySafe: false,
    async execute() {
      executed += 1
      return { content: 'should not run', isError: false }
    }
  })

  const result = await executeToolCalls({
    toolCalls: [
      call('missing-required', 'edit_file', { path: 'src/a.ts' }),
      call('empty-path', 'edit_file', { path: '   ', content: 'x' }),
    ],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 1,
  })

  assert.equal(executed, 0)
  assert.match(result[0]?.content ?? '', /missing required argument `content`/i)
  assert.match(result[1]?.content ?? '', /`path` must be a non-empty string/i)
})

test('execute rejects malformed path-like arguments before tool execution', async () => {
  const registry = new ToolRegistry()
  let executed = 0
  registry.register({
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' }
      },
      required: ['file_path']
    },
    concurrencySafe: true,
    async execute() {
      executed += 1
      return { content: 'should not run', isError: false }
    }
  })

  const result = await executeToolCalls({
    toolCalls: [
      call('colon-prefix', 'read_file', { file_path: ':/src/app.ts' }),
      call('label-prefix', 'read_file', { file_path: 'file_path: src/app.ts' }),
      call('code-fence', 'read_file', { file_path: '```ts\nsrc/app.ts\n```' }),
      call('functions-wrapper', 'read_file', { file_path: '>functions.read_file:1<|tool_call_argument_begin|>{"path":"README.md"}' }),
      call('xml-parameter', 'read_file', { file_path: '<parameter name="path">src/app.ts</parameter>' }),
    ],
    registry,
    toolContext: { cwd: process.cwd() },
    maxConcurrency: 1,
  })

  assert.equal(executed, 0)
  assert.match(result[0]?.content ?? '', /looks malformed/i)
  assert.match(result[1]?.content ?? '', /looks malformed/i)
  assert.match(result[2]?.content ?? '', /looks malformed/i)
  assert.match(result[3]?.content ?? '', /looks malformed/i)
  assert.match(result[4]?.content ?? '', /looks malformed/i)
})
