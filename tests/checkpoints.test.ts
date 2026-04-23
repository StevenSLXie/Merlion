import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { createGitCheckpoint, listGitCheckpoints, restoreGitCheckpoint, type GitCheckpointRecord } from '../src/runtime/checkpoints.ts'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-checkpoints-'))
  execSync('git init', { cwd: root, stdio: 'ignore' })
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' })
  execSync('git config user.name "Merlion Test"', { cwd: root, stdio: 'ignore' })
  await writeFile(join(root, 'tracked.txt'), 'base\n', 'utf8')
  execSync('git add tracked.txt', { cwd: root, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' })
  return root
}

test('git checkpoint restores dirty pre-run workspace state', async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo, 'tracked.txt'), 'dirty-before-run\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'keep me\n', 'utf8')

    const checkpoint = await createGitCheckpoint({ cwd: repo, sessionId: 'session-dirty' })
    assert.ok(checkpoint)
    assert.equal(checkpoint?.mode, 'stash')

    await writeFile(join(repo, 'tracked.txt'), 'agent-change\n', 'utf8')
    await writeFile(join(repo, 'agent.txt'), 'temporary\n', 'utf8')

    const restored = await restoreGitCheckpoint({ cwd: repo, sessionId: 'session-dirty' })
    assert.ok(restored)
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'dirty-before-run\n')
    assert.equal(await readFile(join(repo, 'notes.txt'), 'utf8'), 'keep me\n')
    await assert.rejects(() => readFile(join(repo, 'agent.txt'), 'utf8'))
    assert.match(restored?.preRestoreBackupStashMessage ?? '', /merlion-pre-undo:session-dirty:/)
    assert.equal(typeof restored?.preRestoreBackupStashCommit, 'string')
    const stashList = execSync('git stash list --format="%H %gs"', { cwd: repo, encoding: 'utf8' })
    assert.match(stashList, /merlion-pre-undo:session-dirty:/)
    assert.match(stashList, new RegExp(restored!.preRestoreBackupStashCommit!))
    assert.throws(
      () => execSync(`git show-ref --verify ${restored!.refName}`, { cwd: repo, stdio: 'pipe' }),
      /show-ref/,
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('git checkpoint restores clean repo back to head state', async () => {
  const repo = await makeRepo()
  try {
    const checkpoint = await createGitCheckpoint({ cwd: repo, sessionId: 'session-clean' })
    assert.ok(checkpoint)
    assert.equal(checkpoint?.mode, 'head')

    await writeFile(join(repo, 'tracked.txt'), 'agent-change\n', 'utf8')
    await writeFile(join(repo, 'agent.txt'), 'temporary\n', 'utf8')

    const restored = await restoreGitCheckpoint({ cwd: repo, sessionId: 'session-clean' })
    assert.ok(restored)
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'base\n')
    await assert.rejects(() => readFile(join(repo, 'agent.txt'), 'utf8'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('restored checkpoint artifacts are pruned by retention and ttl rules', async () => {
  const repo = await makeRepo()
  try {
    const headCommit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
    const checkpointRoot = join(repo, '.merlion', 'checkpoints')
    await mkdir(checkpointRoot, { recursive: true })

    async function writeRecord(record: GitCheckpointRecord): Promise<void> {
      await writeFile(join(checkpointRoot, `${record.checkpointId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      execSync(`git update-ref ${record.refName} ${headCommit}`, { cwd: repo, stdio: 'ignore' })
    }

    const baseNow = Date.now()
    for (let index = 0; index <= 20; index += 1) {
      const record: GitCheckpointRecord = {
        checkpointId: `recent-${String(index).padStart(2, '0')}`,
        sessionId: `session-${index}`,
        projectRoot: repo,
        gitRoot: repo,
        createdAt: new Date(baseNow - index * 1_000).toISOString(),
        headCommit,
        refName: `refs/merlion/checkpoints/recent-${String(index).padStart(2, '0')}`,
        mode: 'head',
        status: 'restored',
        restoredAt: new Date(baseNow - index * 500).toISOString(),
      }
      await writeRecord(record)
    }

    await writeRecord({
      checkpointId: 'stale',
      sessionId: 'session-stale',
      projectRoot: repo,
      gitRoot: repo,
      createdAt: new Date(baseNow - 40 * 24 * 60 * 60 * 1000).toISOString(),
      headCommit,
      refName: 'refs/merlion/checkpoints/stale',
      mode: 'head',
      status: 'restored',
      restoredAt: new Date(baseNow - 39 * 24 * 60 * 60 * 1000).toISOString(),
    })

    const records = await listGitCheckpoints(repo)
    const restoredIds = records.filter((record) => record.status === 'restored').map((record) => record.checkpointId)
    const remainingFiles = (await readdir(checkpointRoot)).filter((name) => name.endsWith('.json'))

    assert.equal(restoredIds.length, 20)
    assert.equal(remainingFiles.length, 20)
    assert.ok(!restoredIds.includes('stale'))
    assert.ok(!restoredIds.includes('recent-20'))
    assert.throws(() => execSync('git show-ref --verify refs/merlion/checkpoints/stale', { cwd: repo, stdio: 'pipe' }))
    assert.throws(() => execSync('git show-ref --verify refs/merlion/checkpoints/recent-20', { cwd: repo, stdio: 'pipe' }))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
