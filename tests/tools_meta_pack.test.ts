import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

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
      { name: 'read_file', description: 'Read files' },
      { name: 'edit_file', description: 'Edit files' }
    ]
  })
  assert.equal(all.isError, false)
  assert.match(all.content, /read_file/)
  const filtered = await toolSearchTool.execute({ query: 'edit' }, {
    cwd: process.cwd(),
    listTools: () => [
      { name: 'read_file', description: 'Read files' },
      { name: 'edit_file', description: 'Edit files' }
    ]
  })
  assert.equal(filtered.isError, false)
  assert.match(filtered.content, /edit_file/)
  assert.equal(filtered.content.includes('read_file'), false)
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
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})
