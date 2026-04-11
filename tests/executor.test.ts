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

