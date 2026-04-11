/**
 * Integration: Wave1 tools (features 043-046).
 *
 * Tests tool correctness in realistic multi-tool workflows without an LLM.
 * Covers:
 *   - File navigation: glob + grep (case-sensitivity, modes) + read_file (offset/limit)
 *   - File API compat: file_path alias, replace_all, start_line/end_line
 *   - Edit workflow: write_file → edit_file replace_all → read_file
 *   - Todo workflow: todos[] full-replace + item append
 *   - Config tool: get / set / reset
 *   - Glob fallback regex: **\/pattern matches root-level files
 *
 * Does NOT require OPENROUTER_API_KEY.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import { globTool } from '../../src/tools/builtin/glob.ts'
import { grepTool } from '../../src/tools/builtin/grep.ts'
import { readFileTool } from '../../src/tools/builtin/read_file.ts'
import { writeFileTool } from '../../src/tools/builtin/write_file.ts'
import { editFileTool } from '../../src/tools/builtin/edit_file.ts'
import { todoWriteTool } from '../../src/tools/builtin/todo_write.ts'
import { configTool } from '../../src/tools/builtin/config.ts'

function allow() {
  return { ask: async () => 'allow' as const }
}

// ---------------------------------------------------------------------------
// Grep: case-sensitivity correctness
// ---------------------------------------------------------------------------

test('wave1/grep: is case-sensitive by default (rg parity)', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'src.ts'), 'const Token = 1\nconst TOKEN = 2\n', 'utf8')

    // Case-sensitive default: 'token' should NOT match 'Token' or 'TOKEN'
    const noMatch = await grepTool.execute({ pattern: 'token', path: 'src.ts' }, { cwd })
    assert.equal(noMatch.isError, false)
    assert.equal(noMatch.content, '(no matches found)', 'should not match different-case tokens by default')

    // Explicit case_sensitive=false enables insensitive mode
    const withInsensitive = await grepTool.execute(
      { pattern: 'token', path: 'src.ts', case_sensitive: false, output_mode: 'content' },
      { cwd }
    )
    assert.equal(withInsensitive.isError, false)
    assert.match(withInsensitive.content, /Token/, 'case_sensitive=false should match Token')
    assert.match(withInsensitive.content, /TOKEN/, 'case_sensitive=false should match TOKEN')

    // -i flag also enables insensitive mode
    const withFlag = await grepTool.execute(
      { pattern: 'token', path: 'src.ts', '-i': true, output_mode: 'content' },
      { cwd }
    )
    assert.equal(withFlag.isError, false)
    assert.match(withFlag.content, /Token/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/grep: case_sensitive=true keeps case-sensitive behaviour', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'src.ts'), 'const TOKEN = 1\n', 'utf8')

    const match = await grepTool.execute(
      { pattern: 'TOKEN', path: 'src.ts', case_sensitive: true, output_mode: 'content' },
      { cwd }
    )
    assert.equal(match.isError, false)
    assert.match(match.content, /TOKEN/)

    const noMatch = await grepTool.execute({ pattern: 'token', path: 'src.ts', case_sensitive: true }, { cwd })
    assert.equal(noMatch.isError, false)
    assert.equal(noMatch.content, '(no matches found)')
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/grep: output_mode=files_with_matches + count', async () => {
  const cwd = await makeSandbox()
  try {
    await mkdir(join(cwd, 'lib'), { recursive: true })
    await writeFile(join(cwd, 'lib', 'a.ts'), 'export const API_KEY = "x"\nexport const API_SECRET = "y"\n', 'utf8')
    await writeFile(join(cwd, 'lib', 'b.ts'), 'export const API_KEY = "z"\n', 'utf8')

    const files = await grepTool.execute(
      { pattern: 'API_KEY', path: 'lib', output_mode: 'files_with_matches' },
      { cwd }
    )
    assert.equal(files.isError, false)
    assert.match(files.content, /a\.ts/)
    assert.match(files.content, /b\.ts/)

    const count = await grepTool.execute(
      { pattern: 'API_KEY', path: 'lib', output_mode: 'count' },
      { cwd }
    )
    assert.equal(count.isError, false)
    assert.match(count.content, /a\.ts:1/)
    assert.match(count.content, /b\.ts:1/)
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// Glob: fallback regex handles **/* root-level files
// ---------------------------------------------------------------------------

test('wave1/glob: ** pattern matches files at root and nested', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'index.ts'), '// root\n', 'utf8')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'app.ts'), '// nested\n', 'utf8')
    await mkdir(join(cwd, 'src', 'deep'), { recursive: true })
    await writeFile(join(cwd, 'src', 'deep', 'util.ts'), '// deep\n', 'utf8')

    const result = await globTool.execute({ pattern: '**/*.ts', path: '.' }, { cwd })
    assert.equal(result.isError, false)
    assert.match(result.content, /index\.ts/, '** pattern must match root-level files')
    assert.match(result.content, /src\/app\.ts/, '** pattern must match nested files')
    assert.match(result.content, /src\/deep\/util\.ts/, '** pattern must match deeply nested files')
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/glob: *.ts pattern matches only root-level within path', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'a.ts'), '', 'utf8')
    await mkdir(join(cwd, 'sub'), { recursive: true })
    await writeFile(join(cwd, 'sub', 'b.ts'), '', 'utf8')

    // *.ts at cwd root matches root files, rg glob is anchored to base
    const result = await globTool.execute({ pattern: '*.ts', path: '.' }, { cwd })
    assert.equal(result.isError, false)
    assert.match(result.content, /a\.ts/)
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// read_file: file_path alias + offset/limit + start_line/end_line
// ---------------------------------------------------------------------------

test('wave1/read_file: file_path alias works', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'hello.ts'), 'line1\nline2\nline3\n', 'utf8')

    const result = await readFileTool.execute({ file_path: 'hello.ts' }, { cwd })
    assert.equal(result.isError, false)
    assert.match(result.content, /line1/)
    assert.match(result.content, /line3/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/read_file: offset + limit returns correct window', async () => {
  const cwd = await makeSandbox()
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    await writeFile(join(cwd, 'f.ts'), lines.join('\n') + '\n', 'utf8')

    // Read lines 3–5 (offset=3, limit=3)
    const result = await readFileTool.execute({ path: 'f.ts', offset: 3, limit: 3 }, { cwd })
    assert.equal(result.isError, false)
    assert.match(result.content, /line3/)
    assert.match(result.content, /line4/)
    assert.match(result.content, /line5/)
    assert.equal(result.content.includes('line2'), false, 'Should not include line before offset')
    assert.equal(result.content.includes('line6'), false, 'Should not include line after limit')
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/read_file: start_line + end_line range', async () => {
  const cwd = await makeSandbox()
  try {
    const lines = Array.from({ length: 8 }, (_, i) => `row${i + 1}`)
    await writeFile(join(cwd, 'r.ts'), lines.join('\n') + '\n', 'utf8')

    const result = await readFileTool.execute({ path: 'r.ts', start_line: 2, end_line: 4 }, { cwd })
    assert.equal(result.isError, false)
    assert.match(result.content, /row2/)
    assert.match(result.content, /row3/)
    assert.match(result.content, /row4/)
    assert.equal(result.content.includes('row1'), false)
    assert.equal(result.content.includes('row5'), false)
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// write_file + edit_file: file_path alias + replace_all
// ---------------------------------------------------------------------------

test('wave1/edit_file: file_path alias works', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'f.ts'), 'const x = 1\n', 'utf8')

    const result = await editFileTool.execute(
      { file_path: 'f.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
      { cwd, permissions: allow() }
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /Edited/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/edit_file: replace_all replaces every occurrence', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(
      join(cwd, 'f.ts'),
      'const OLD = 1\nconst OLD = 2\nconst OLD = 3\n',
      'utf8'
    )

    const result = await editFileTool.execute(
      { path: 'f.ts', old_string: 'OLD', new_string: 'NEW', replace_all: true },
      { cwd, permissions: allow() }
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /\[replace_all=3\]/, 'should report 3 replacements')

    const read = await readFileTool.execute({ path: 'f.ts' }, { cwd })
    assert.equal(read.content.includes('OLD'), false, 'all OLD occurrences must be replaced')
    assert.match(read.content, /NEW/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/edit_file: replace_all=false blocks multi-match', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(join(cwd, 'f.ts'), 'const X = 1\nconst X = 2\n', 'utf8')

    const result = await editFileTool.execute(
      { path: 'f.ts', old_string: 'const X', new_string: 'const Y' },
      { cwd, permissions: allow() }
    )
    assert.equal(result.isError, true)
    assert.match(result.content, /2 occurrences/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/write_file: file_path alias works', async () => {
  const cwd = await makeSandbox()
  try {
    const result = await writeFileTool.execute(
      { file_path: 'out.ts', content: 'export const n = 42\n' },
      { cwd, permissions: allow() }
    )
    assert.equal(result.isError, false)

    const read = await readFileTool.execute({ file_path: 'out.ts' }, { cwd })
    assert.match(read.content, /42/)
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// Combined file workflow: grep → read_file (offset) → edit_file → verify
// ---------------------------------------------------------------------------

test('wave1/workflow: search → targeted read → replace_all → verify', async () => {
  const cwd = await makeSandbox()
  try {
    await writeFile(
      join(cwd, 'config.ts'),
      [
        'export const VERSION = "1.0.0"',
        'export const APP_NAME = "demo"',
        'export const MAX_RETRIES = 3',
        'export const TIMEOUT = VERSION // reuses VERSION string',
      ].join('\n') + '\n',
      'utf8'
    )

    // 1. grep to locate VERSION occurrences
    const grep = await grepTool.execute(
      { pattern: 'VERSION', path: 'config.ts', output_mode: 'content' },
      { cwd }
    )
    assert.equal(grep.isError, false)
    assert.match(grep.content, /VERSION/)

    // 2. read specific lines
    const read = await readFileTool.execute({ path: 'config.ts', start_line: 1, end_line: 1 }, { cwd })
    assert.equal(read.isError, false)
    assert.match(read.content, /1\.0\.0/)

    // 3. replace_all VERSION → V (appears 3× total: line1×1, line4×2)
    const edit = await editFileTool.execute(
      { path: 'config.ts', old_string: 'VERSION', new_string: 'V', replace_all: true },
      { cwd, permissions: allow() }
    )
    assert.equal(edit.isError, false)
    assert.match(edit.content, /\[replace_all=3\]/)

    // 4. verify no VERSION remains
    const grepAfter = await grepTool.execute({ pattern: 'VERSION', path: 'config.ts' }, { cwd })
    assert.equal(grepAfter.isError, false)
    assert.equal(grepAfter.content, '(no matches found)')
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// todo_write: todos[] full-replace + item append
// ---------------------------------------------------------------------------

test('wave1/todo_write: todos[] payload saves and reads back correctly', async () => {
  const cwd = await makeSandbox()
  try {
    const result = await todoWriteTool.execute(
      {
        path: '.merlion/todos.json',
        todos: [
          { content: 'write unit tests', status: 'in_progress' },
          { content: 'update docs', status: 'pending' },
        ]
      },
      { cwd, permissions: allow() }
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /Updated todo list 0 -> 2/)
    assert.match(result.content, /write unit tests/)
    assert.match(result.content, /update docs/)
  } finally {
    await rmSandbox(cwd)
  }
})

test('wave1/todo_write: item append creates markdown file', async () => {
  const cwd = await makeSandbox()
  try {
    await todoWriteTool.execute({ item: 'task A', path: 'TODO.md' }, { cwd, permissions: allow() })
    await todoWriteTool.execute({ item: 'task B', checked: true, path: 'TODO.md' }, { cwd, permissions: allow() })

    const read = await readFileTool.execute({ path: 'TODO.md' }, { cwd })
    assert.match(read.content, /\[ \] task A/)
    assert.match(read.content, /\[x\] task B/)
  } finally {
    await rmSandbox(cwd)
  }
})

// ---------------------------------------------------------------------------
// config tool: get / set / reset
// ---------------------------------------------------------------------------

test('wave1/config: get + set + reset roundtrip', async () => {
  const cwd = await makeSandbox()
  const prevXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(cwd, '.xdg')
  try {
    const notSet = await configTool.execute({ setting: 'model' }, { cwd })
    assert.equal(notSet.isError, false)
    assert.match(notSet.content, /not set/)

    const set = await configTool.execute({ setting: 'model', value: 'test/model-v1' }, { cwd, permissions: allow() })
    assert.equal(set.isError, false)
    assert.match(set.content, /Set model=test\/model-v1/)

    const get = await configTool.execute({ setting: 'model' }, { cwd })
    assert.equal(get.isError, false)
    assert.match(get.content, /test\/model-v1/)

    const reset = await configTool.execute({ setting: 'model', value: 'default' }, { cwd, permissions: allow() })
    assert.equal(reset.isError, false)
    assert.match(reset.content, /Reset model to default/)

    const afterReset = await configTool.execute({ setting: 'model' }, { cwd })
    assert.match(afterReset.content, /not set/)
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    await rmSandbox(cwd)
  }
})
