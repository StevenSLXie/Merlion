import test from 'node:test'
import assert from 'node:assert/strict'

import { getBuiltinToolCatalog } from '../src/tools/catalog.ts'
import { assembleToolPool } from '../src/tools/pool.ts'
import { buildDefaultRegistry, buildRegistryFromPool } from '../src/tools/builtin/index.ts'

test('builtin catalog returns stable tool list', () => {
  const catalog = getBuiltinToolCatalog()
  const names = catalog.map((tool) => tool.name)
  assert.deepEqual(names, [
    'read_file',
    'list_dir',
    'stat_path',
    'search',
    'grep',
    'glob',
    'write_file',
    'append_file',
    'create_file',
    'edit_file',
    'copy_file',
    'move_file',
    'delete_file',
    'mkdir',
    'bash',
    'run_script',
    'list_scripts',
    'git_status',
    'git_diff',
    'git_log',
    'fetch',
    'lsp',
    'tool_search',
    'spawn_agent',
    'todo_write',
    'ask_user_question',
    'config',
    'config_get',
    'config_set',
    'sleep',
    'wait_agent',
  ])
  assert.equal(catalog.find((tool) => tool.name === 'read_file')?.source, 'builtin')
  assert.equal(catalog.find((tool) => tool.name === 'read_file')?.isReadOnly, true)
  assert.match(catalog.find((tool) => tool.name === 'read_file')?.modelGuidance ?? '', /raw workspace path/i)
  assert.match(catalog.find((tool) => tool.name === 'edit_file')?.modelGuidance ?? '', /Read the target file first/i)
  assert.match(catalog.find((tool) => tool.name === 'bash')?.modelGuidance ?? '', /Use bash for tests/i)
  assert.match(catalog.find((tool) => tool.name === 'write_file')?.modelGuidance ?? '', /replace the whole file contents/i)
  assert.match(catalog.find((tool) => tool.name === 'tool_search')?.modelGuidance ?? '', /select:<tool_name>/i)
  assert.match(catalog.find((tool) => tool.name === 'todo_write')?.modelGuidance ?? '', /verification or validation/i)
  assert.equal(catalog.find((tool) => tool.name === 'delete_file')?.isDestructive, true)
})

test('tool pool default mode returns builtin set', () => {
  const pooled = assembleToolPool({ mode: 'default' }).map((tool) => tool.name)
  assert.deepEqual(pooled, getBuiltinToolCatalog().map((tool) => tool.name))
})

test('tool pool wechat mode excludes config tools', () => {
  const pooled = assembleToolPool({ mode: 'wechat' }).map((tool) => tool.name)
  assert.equal(pooled.includes('config'), false)
  assert.equal(pooled.includes('config_get'), false)
  assert.equal(pooled.includes('config_set'), false)
  assert.equal(pooled.includes('bash'), false)
  assert.equal(pooled.includes('run_script'), false)
  assert.equal(pooled.includes('ask_user_question'), false)
  assert.equal(pooled.includes('read_file'), true)
  assert.equal(pooled.includes('lsp'), true)
  assert.equal(pooled.includes('tool_search'), true)
})

test('tool pool includeNames narrows visible tools', () => {
  const pooled = assembleToolPool({
    mode: 'default',
    includeNames: ['read_file', 'tool_search', 'missing'],
  }).map((tool) => tool.name)
  assert.deepEqual(pooled, ['read_file', 'tool_search'])
})

test('tool pool excludeNames removes named tools while preserving order', () => {
  const pooled = assembleToolPool({
    mode: 'default',
    excludeNames: ['search', 'glob', 'config'],
  }).map((tool) => tool.name)
  assert.equal(pooled.includes('search'), false)
  assert.equal(pooled.includes('glob'), false)
  assert.equal(pooled.includes('config'), false)
  assert.deepEqual(pooled.slice(0, 5), ['read_file', 'list_dir', 'stat_path', 'grep', 'write_file'])
})

test('buildRegistryFromPool only registers pooled tools', () => {
  const pool = assembleToolPool({ includeNames: ['read_file', 'tool_search'] })
  const registry = buildRegistryFromPool(pool)
  assert.deepEqual(registry.getAll().map((tool) => tool.name), ['read_file', 'tool_search'])
  assert.equal(registry.get('config'), undefined)
})

test('buildDefaultRegistry consumes pooled tools', () => {
  const registry = buildDefaultRegistry({ mode: 'wechat' })
  assert.equal(registry.get('config'), undefined)
  assert.equal(registry.get('config_get'), undefined)
  assert.equal(registry.get('read_file')?.name, 'read_file')
})
