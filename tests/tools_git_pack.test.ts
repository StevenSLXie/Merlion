import { mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { gitDiffTool } from '../src/tools/builtin/git_diff.ts'
import { gitLogTool } from '../src/tools/builtin/git_log.ts'
import { gitStatusTool } from '../src/tools/builtin/git_status.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-tools-git-'))
}

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr}`)
  }
}

test('git_status/git_diff/git_log basic flow', async () => {
  const cwd = await makeTempDir()
  run('git', ['init'], cwd)
  run('git', ['config', 'user.email', 'test@example.com'], cwd)
  run('git', ['config', 'user.name', 'Test'], cwd)

  await writeFile(join(cwd, 'a.txt'), 'line1\n', 'utf8')
  run('git', ['add', 'a.txt'], cwd)
  run('git', ['commit', '-m', 'init'], cwd)

  await writeFile(join(cwd, 'a.txt'), 'line1\nline2\n', 'utf8')
  const status = await gitStatusTool.execute({}, { cwd })
  assert.equal(status.isError, false)
  assert.match(status.content, /a\.txt/)

  const diff = await gitDiffTool.execute({ path: 'a.txt' }, { cwd })
  assert.equal(diff.isError, false)
  assert.match(diff.content, /\+line2/)

  const log = await gitLogTool.execute({ limit: 1 }, { cwd })
  assert.equal(log.isError, false)
  assert.match(log.content, /init/)
})
