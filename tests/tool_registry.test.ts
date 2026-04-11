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
  const read = makeTool('read_file')

  registry.register(read)

  assert.equal(registry.get('read_file'), read)
  assert.equal(registry.get('missing'), undefined)
})

test('duplicate registration throws', () => {
  const registry = new ToolRegistry()
  registry.register(makeTool('read_file'))

  assert.throws(() => registry.register(makeTool('read_file')), /already registered/i)
})

test('getAll preserves insertion order', () => {
  const registry = new ToolRegistry()
  const read = makeTool('read_file')
  const search = makeTool('search')
  const edit = makeTool('edit_file')

  registry.register(read)
  registry.register(search)
  registry.register(edit)

  assert.deepEqual(
    registry.getAll().map((tool) => tool.name),
    ['read_file', 'search', 'edit_file']
  )
})

