import test from 'node:test'
import assert from 'node:assert/strict'

import type { ToolDefinition } from '../src/tools/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    concurrencySafe: true,
    async execute() {
      return { content: 'ok', isError: false }
    }
  }
}

test('register and get by name', () => {
  const registry = new ToolRegistry()
  const read: ToolDefinition = {
    ...makeTool('read_file'),
    parameters: {
      type: 'object',
      properties: {
        mode: { enum: ['write', 'read'], type: ['string', 'null'] },
        path: { type: 'string' },
      },
      required: ['path', 'mode'],
    },
  }

  registry.register(read)

  assert.deepEqual(registry.get('read_file'), {
    ...read,
    parameters: {
      properties: {
        mode: { enum: ['read', 'write'], type: ['null', 'string'] },
        path: { type: 'string' },
      },
      required: ['mode', 'path'],
      type: 'object',
    },
  })
  assert.equal(registry.get('missing'), undefined)
})

test('duplicate registration throws', () => {
  const registry = new ToolRegistry()
  registry.register(makeTool('read_file'))

  assert.throws(() => registry.register(makeTool('read_file')), /already registered/i)
})

test('getAll returns deterministic name order', () => {
  const registry = new ToolRegistry()
  const read = makeTool('read_file')
  const search = makeTool('search')
  const edit = makeTool('edit_file')

  registry.register(read)
  registry.register(search)
  registry.register(edit)

  assert.deepEqual(
    registry.getAll().map((tool) => tool.name),
    ['edit_file', 'read_file', 'search']
  )
})
