import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { configTool } from '../src/tools/builtin/config.ts'
import { configGetTool } from '../src/tools/builtin/config_get.ts'
import { configSetTool } from '../src/tools/builtin/config_set.ts'
import { listScriptsTool } from '../src/tools/builtin/list_scripts.ts'
import { runScriptTool } from '../src/tools/builtin/run_script.ts'
import { sleepTool } from '../src/tools/builtin/sleep.ts'
import { todoWriteTool } from '../src/tools/builtin/todo_write.ts'
import { toolSearchTool } from '../src/tools/builtin/tool_search.ts'
import type { PermissionStore } from '../src/tools/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-tools-meta-'))
}

function permission(value: 'allow' | 'deny' | 'allow_session'): PermissionStore {
  return { ask: async () => value }
}

test('tool_search lists tools and supports query', async () => {
  const all = await toolSearchTool.execute({}, {
    cwd: process.cwd(),
    listTools: () => [
      { name: 'read_file', description: 'Read files', source: 'builtin', searchHint: 'read file contents' },
      { name: 'edit_file', description: 'Edit files', source: 'builtin', searchHint: 'replace text in file' }
    ]
  })
  assert.equal(all.isError, false)
  assert.match(all.content, /read_file/)
  const filtered = await toolSearchTool.execute({ query: 'edit' }, {
    cwd: process.cwd(),
    listTools: () => [
      { name: 'read_file', description: 'Read files', source: 'builtin', searchHint: 'read file contents' },
      { name: 'edit_file', description: 'Edit files', source: 'builtin', searchHint: 'replace text in file' }
    ]
  })
  assert.equal(filtered.isError, false)
  assert.match(filtered.content, /edit_file/)
  assert.equal(filtered.content.includes('read_file'), false)

  const selected = await toolSearchTool.execute(
    { query: 'select:read_file' },
    {
      cwd: process.cwd(),
      listTools: () => [
        { name: 'read_file', description: 'Read files', source: 'builtin', searchHint: 'read file contents' },
        { name: 'edit_file', description: 'Edit files', source: 'builtin', searchHint: 'replace text in file' }
      ]
    }
  )
  assert.equal(selected.isError, false)
  assert.equal(selected.content.includes('read_file'), true)
})

test('tool_search matches searchHint when query is not in tool name', async () => {
  const result = await toolSearchTool.execute({ query: 'replace text' }, {
    cwd: process.cwd(),
    listTools: () => [
      { name: 'read_file', description: 'Read files', source: 'builtin', searchHint: 'read file contents' },
      { name: 'edit_file', description: 'Edit files', source: 'builtin', searchHint: 'replace text in file' }
    ]
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /edit_file/)
  assert.equal(result.content.includes('read_file'), false)
})

test('list_scripts and run_script work against package.json', async () => {
  const cwd = await makeTempDir()
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'x',
    version: '1.0.0',
    scripts: {
      ping: 'node -e "console.log(\'ok\')"'
    }
  }, null, 2), 'utf8')

  const list = await listScriptsTool.execute({}, { cwd })
  assert.equal(list.isError, false)
  assert.match(list.content, /ping/)

  const run = await runScriptTool.execute({ script: 'ping', timeout_ms: 15_000 }, { cwd, permissions: permission('allow') })
  assert.equal(run.isError, false)
  assert.match(run.content, /ok/)
})

test('todo_write appends markdown checklist item', async () => {
  const cwd = await makeTempDir()
  const result = await todoWriteTool.execute(
    { item: 'do thing', path: 'docs/todo.md' },
    { cwd, permissions: permission('allow') }
  )
  assert.equal(result.isError, false)
  const text = await readFile(join(cwd, 'docs', 'todo.md'), 'utf8')
  assert.match(text, /\- \[ \] do thing/)
})

test('sleep waits with bounded duration', async () => {
  const start = Date.now()
  const result = await sleepTool.execute({ duration_ms: 20 }, { cwd: process.cwd() })
  const elapsed = Date.now() - start
  assert.equal(result.isError, false)
  assert.ok(elapsed >= 10)

  const bySeconds = await sleepTool.execute({ duration_seconds: 1 }, { cwd: process.cwd() })
  assert.equal(bySeconds.isError, false)
})

test('config_set/config_get roundtrip in temp XDG dir', async () => {
  const cwd = await makeTempDir()
  const xdg = join(cwd, 'xdg')
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  try {
    const set = await configSetTool.execute(
      { key: 'model', value: 'qwen/qwen3-coder' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(set.isError, false)
    const get = await configGetTool.execute({ key: 'model' }, { cwd })
    assert.equal(get.isError, false)
    assert.match(get.content, /qwen\/qwen3-coder/)

    const setProvider = await configSetTool.execute(
      { key: 'provider', value: 'openrouter' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(setProvider.isError, false)
    const getProvider = await configGetTool.execute({ key: 'provider' }, { cwd })
    assert.equal(getProvider.isError, false)
    assert.match(getProvider.content, /provider=openrouter/)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test('config tool supports get, set and reset', async () => {
  const cwd = await makeTempDir()
  const xdg = join(cwd, 'xdg')
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  try {
    const set = await configTool.execute(
      { setting: 'model', value: 'qwen/qwen3-coder' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(set.isError, false)
    assert.match(set.content, /Set model=qwen\/qwen3-coder/)

    const get = await configTool.execute({ setting: 'model' }, { cwd })
    assert.equal(get.isError, false)
    assert.match(get.content, /model=qwen\/qwen3-coder/)

    const reset = await configTool.execute(
      { setting: 'model', value: 'default' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(reset.isError, false)
    assert.match(reset.content, /Reset model to default/)

    const setProvider = await configTool.execute(
      { setting: 'provider', value: 'openai' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(setProvider.isError, false)
    assert.match(setProvider.content, /Set provider=openai/)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test('config provider rejects unsupported value', async () => {
  const cwd = await makeTempDir()
  const xdg = join(cwd, 'xdg')
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  try {
    const viaConfig = await configTool.execute(
      { setting: 'provider', value: 'bad-provider' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(viaConfig.isError, true)
    assert.match(viaConfig.content, /Invalid provider/)

    const viaConfigSet = await configSetTool.execute(
      { key: 'provider', value: 'bad-provider' },
      { cwd, permissions: permission('allow') }
    )
    assert.equal(viaConfigSet.isError, true)
    assert.match(viaConfigSet.content, /Invalid provider/)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test('todo_write supports full todo list payload', async () => {
  const cwd = await makeTempDir()
  const updated = await todoWriteTool.execute(
    {
      path: '.merlion/todos.json',
      todos: [
        { content: 'implement parser', status: 'in_progress', activeForm: 'implementing parser' },
        { content: 'write tests', status: 'pending' }
      ]
    },
    { cwd, permissions: permission('allow') }
  )
  assert.equal(updated.isError, false)
  assert.match(updated.content, /Updated todo list/)
  const content = await readFile(join(cwd, '.merlion', 'todos.json'), 'utf8')
  assert.match(content, /implement parser/)
  assert.match(content, /write tests/)
})
