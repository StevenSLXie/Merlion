import { mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import { gitDiffTool } from '../src/tools/builtin/git_diff.ts'
import { gitLogTool } from '../src/tools/builtin/git_log.ts'
import { gitStatusTool } from '../src/tools/builtin/git_status.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'

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

test('git tools respect deny-read constraints', async () => {
  const cwd = await makeTempDir()
  run('git', ['init'], cwd)
  run('git', ['config', 'user.email', 'test@example.com'], cwd)
  run('git', ['config', 'user.name', 'Test'], cwd)

  await writeFile(join(cwd, '.env'), 'SECRET=1\n', 'utf8')
  await writeFile(join(cwd, 'safe.txt'), 'ok\n', 'utf8')
  run('git', ['add', '.env', 'safe.txt'], cwd)
  run('git', ['commit', '-m', 'init'], cwd)
  await writeFile(join(cwd, '.env'), 'SECRET=2\n', 'utf8')

  const sandbox = {
    policy: resolveSandboxPolicy({
      cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      denyRead: ['.env'],
    }),
    backend: {
      name: () => 'test',
      isAvailableForPolicy: async () => true,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    },
  }

  const diffAll = await gitDiffTool.execute({}, { cwd, sandbox })
  assert.equal(diffAll.isError, true)
  assert.match(diffAll.content, /explicit allowed path/i)

  const diffBlocked = await gitDiffTool.execute({ path: '.env' }, { cwd, sandbox })
  assert.equal(diffBlocked.isError, true)
  assert.match(diffBlocked.content, /deny-read|sandbox-protected/i)

  const status = await gitStatusTool.execute({}, { cwd, sandbox })
  assert.equal(status.isError, false)
  assert.doesNotMatch(status.content, /\.env/)

  const logAll = await gitLogTool.execute({ limit: 1 }, { cwd, sandbox })
  assert.equal(logAll.isError, true)
  assert.match(logAll.content, /explicit allowed path/i)

  const logBlocked = await gitLogTool.execute({ limit: 1, path: '.env' }, { cwd, sandbox })
  assert.equal(logBlocked.isError, true)
  assert.match(logBlocked.content, /deny-read|sandbox-protected/i)
})
