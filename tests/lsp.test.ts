import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { lspTool } from '../src/tools/builtin/lsp.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'

async function makeTsProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-lsp-'))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2), 'utf8')
  return cwd
}

async function setupProjectFiles(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'src', 'lib.ts'), [
    'export function greet(name: string): string {',
    '  return `hello ${name}`',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(cwd, 'src', 'main.ts'), [
    "import { greet } from './lib.js'",
    '',
    "const message = greet('Merlion')",
    'console.log(message)',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(cwd, 'src', 'broken.ts'), [
    'const count: number = "oops"',
    'export { count }',
    '',
  ].join('\n'), 'utf8')
}

test('lsp returns definition and references for imported symbol', async () => {
  const cwd = await makeTsProject()
  await setupProjectFiles(cwd)

  const definition = await lspTool.execute({ action: 'definition', path: 'src/main.ts', line: 3, character: 17 }, { cwd })
  assert.equal(definition.isError, false)
  const parsedDefinition = JSON.parse(definition.content)
  assert.equal(parsedDefinition.results[0].path, 'src/lib.ts')

  const references = await lspTool.execute({ action: 'references', path: 'src/main.ts', line: 3, character: 17 }, { cwd })
  assert.equal(references.isError, false)
  const parsedReferences = JSON.parse(references.content)
  assert.ok(parsedReferences.results.some((item: { path: string }) => item.path === 'src/lib.ts'))
  assert.ok(parsedReferences.results.some((item: { path: string }) => item.path === 'src/main.ts'))
})

test('lsp returns hover, document symbols, workspace symbols, and diagnostics', async () => {
  const cwd = await makeTsProject()
  await setupProjectFiles(cwd)

  const hover = await lspTool.execute({ action: 'hover', path: 'src/main.ts', line: 3, character: 17 }, { cwd })
  assert.equal(hover.isError, false)
  assert.match(hover.content, /greet\(name: string\): string/)

  const symbols = await lspTool.execute({ action: 'document_symbols', path: 'src/lib.ts' }, { cwd })
  assert.equal(symbols.isError, false)
  assert.match(symbols.content, /greet/)

  const workspace = await lspTool.execute({ action: 'workspace_symbols', query: 'greet' }, { cwd })
  assert.equal(workspace.isError, false)
  assert.match(workspace.content, /src\/lib\.ts/)

  const diagnostics = await lspTool.execute({ action: 'diagnostics', path: 'src/broken.ts' }, { cwd })
  assert.equal(diagnostics.isError, false)
  assert.match(diagnostics.content, /Type 'string' is not assignable to type 'number'/)
})

test('lsp rejects unsupported files', async () => {
  const result = await lspTool.execute({ action: 'document_symbols', path: 'README.md' }, { cwd: process.cwd() })
  assert.equal(result.isError, true)
  assert.match(result.content, /Unsupported file for lsp/)
})

test('lsp respects deny-read policy for blocked files', async () => {
  const cwd = await makeTsProject()
  await setupProjectFiles(cwd)

  const result = await lspTool.execute(
    { action: 'document_symbols', path: 'src/lib.ts' },
    {
      cwd,
      sandbox: {
        policy: resolveSandboxPolicy({
          cwd,
          sandboxMode: 'workspace-write',
          approvalPolicy: 'never',
          denyRead: ['src/lib.ts'],
        }),
        backend: {
          name: () => 'test',
          isAvailableForPolicy: async () => true,
          run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
        },
      },
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /deny-read/i)
})
