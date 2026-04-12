import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runProcess } from '../src/tools/builtin/process_common.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-process-common-'))
}

test('runProcess settles promptly when parent exits and background child inherits stdio', async () => {
  const cwd = await makeTempDir()
  const startedAt = Date.now()
  const result = await runProcess(
    'bash',
    ['-lc', 'node -e "setTimeout(() => {}, 2200)" & echo started'],
    cwd,
    { timeoutMs: 5_000 }
  )
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.match(result.stdout, /started/)
  assert.ok(elapsedMs < 1_800, `Expected fast settlement, got ${elapsedMs}ms`)
})
