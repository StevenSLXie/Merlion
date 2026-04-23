import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { findProjectRoot } from '../artifacts/project_root.ts'
import { runProcess } from '../tools/builtin/process_common.ts'

export interface GitCheckpointRecord {
  checkpointId: string
  sessionId: string
  projectRoot: string
  gitRoot: string
  createdAt: string
  headCommit: string
  refName: string
  mode: 'head' | 'stash'
  status: 'active' | 'restored'
  restoredAt?: string
  preRestoreBackupStashCommit?: string
  preRestoreBackupStashMessage?: string
}

const CHECKPOINT_RETENTION_COUNT = 20
const CHECKPOINT_RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000

function checkpointDir(projectRoot: string): string {
  return join(projectRoot, '.merlion', 'checkpoints')
}

function checkpointRecordPath(projectRoot: string, checkpointId: string): string {
  return join(checkpointDir(projectRoot), `${checkpointId}.json`)
}

async function runGit(
  cwd: string,
  args: string[],
  options?: {
    timeoutMs?: number
    maxOutputChars?: number
  },
): Promise<{ stdout: string; stderr: string }> {
  const result = await runProcess('git', args, cwd, {
    timeoutMs: options?.timeoutMs ?? 120_000,
    maxOutputChars: options?.maxOutputChars ?? 80_000,
  })
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim())
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

async function findGitRoot(cwd: string): Promise<string | null> {
  const result = await runProcess('git', ['rev-parse', '--show-toplevel'], cwd, { timeoutMs: 15_000, maxOutputChars: 20_000 })
  if (result.exitCode !== 0) return null
  const root = result.stdout.trim()
  return root === '' ? null : root
}

async function readCheckpointRecord(path: string): Promise<GitCheckpointRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as GitCheckpointRecord
    if (
      typeof parsed.checkpointId !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.projectRoot !== 'string' ||
      typeof parsed.gitRoot !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.headCommit !== 'string' ||
      typeof parsed.refName !== 'string' ||
      (parsed.mode !== 'head' && parsed.mode !== 'stash') ||
      (parsed.status !== 'active' && parsed.status !== 'restored')
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeCheckpointRecord(record: GitCheckpointRecord): Promise<void> {
  await mkdir(checkpointDir(record.projectRoot), { recursive: true })
  await writeFile(checkpointRecordPath(record.projectRoot, record.checkpointId), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

async function deleteGitRef(gitRoot: string, refName: string): Promise<void> {
  const result = await runProcess('git', ['update-ref', '-d', refName], gitRoot, { timeoutMs: 30_000, maxOutputChars: 20_000 })
  if (result.exitCode !== 0 && !/cannot lock ref|not a valid ref|reference does not exist/i.test(result.stderr)) {
    throw new Error((result.stderr || result.stdout || `git update-ref -d ${refName} failed`).trim())
  }
}

async function pruneCheckpointArtifacts(projectRoot: string, gitRoot: string): Promise<void> {
  const dir = checkpointDir(projectRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }

  const restoredRecords = (await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => await readCheckpointRecord(join(dir, name)))
  )).filter((record): record is GitCheckpointRecord => record !== null && record.status === 'restored')

  const cutoff = Date.now() - CHECKPOINT_RETENTION_AGE_MS
  restoredRecords.sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  const toDelete = restoredRecords.filter((record, index) => {
    const createdAt = Date.parse(record.createdAt)
    const isStale = Number.isFinite(createdAt) && createdAt < cutoff
    const exceedsCount = index >= CHECKPOINT_RETENTION_COUNT
    return isStale || exceedsCount
  })

  await Promise.all(toDelete.map(async (record) => {
    await deleteGitRef(gitRoot, record.refName).catch(() => {})
    await unlink(checkpointRecordPath(projectRoot, record.checkpointId)).catch(() => {})
  }))
}

export async function createGitCheckpoint(params: {
  cwd: string
  sessionId: string
}): Promise<GitCheckpointRecord | null> {
  const projectRoot = await findProjectRoot(params.cwd)
  const gitRoot = await findGitRoot(params.cwd)
  if (!gitRoot) return null

  const headCommit = (await runGit(gitRoot, ['rev-parse', 'HEAD'])).stdout
  const status = (await runGit(gitRoot, ['status', '--porcelain', '--untracked-files=all'])).stdout
  const checkpointId = randomUUID()
  const refName = `refs/merlion/checkpoints/${checkpointId}`
  const record: GitCheckpointRecord = {
    checkpointId,
    sessionId: params.sessionId,
    projectRoot,
    gitRoot,
    createdAt: new Date().toISOString(),
    headCommit,
    refName,
    mode: status === '' ? 'head' : 'stash',
    status: 'active',
  }

  if (record.mode === 'head') {
    await runGit(gitRoot, ['update-ref', refName, headCommit])
    await writeCheckpointRecord(record)
    await pruneCheckpointArtifacts(projectRoot, gitRoot)
    return record
  }

  await runGit(gitRoot, ['stash', 'push', '-u', '-m', `merlion-checkpoint:${checkpointId}:${params.sessionId}`], { timeoutMs: 160_000 })
  const topHash = (await runGit(gitRoot, ['rev-parse', '--verify', 'stash@{0}'])).stdout
  await runGit(gitRoot, ['update-ref', refName, topHash])
  try {
    await runGit(gitRoot, ['stash', 'apply', '--index', topHash], { timeoutMs: 200_000 })
  } finally {
    const currentTop = await runProcess('git', ['rev-parse', '--verify', 'stash@{0}'], gitRoot, { timeoutMs: 15_000, maxOutputChars: 20_000 })
    if (currentTop.exitCode === 0 && currentTop.stdout.trim() === topHash) {
      await runGit(gitRoot, ['stash', 'drop', 'stash@{0}'])
    }
  }
  await writeCheckpointRecord(record)
  await pruneCheckpointArtifacts(projectRoot, gitRoot)
  return record
}

export async function listGitCheckpoints(cwd: string): Promise<GitCheckpointRecord[]> {
  const projectRoot = await findProjectRoot(cwd)
  const gitRoot = await findGitRoot(cwd)
  if (gitRoot) {
    await pruneCheckpointArtifacts(projectRoot, gitRoot)
  }
  const dir = checkpointDir(projectRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = (await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => await readCheckpointRecord(join(dir, name)))
  )).filter((record): record is GitCheckpointRecord => record !== null)
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return records
}

export async function restoreGitCheckpoint(params: {
  cwd: string
  sessionId?: string
}): Promise<GitCheckpointRecord | null> {
  const records = await listGitCheckpoints(params.cwd)
  const record = params.sessionId
    ? records.find((entry) => entry.sessionId === params.sessionId && entry.status === 'active')
    : records.find((entry) => entry.status === 'active')
  if (!record) return null

  const preRestoreStatus = (await runGit(record.gitRoot, ['status', '--porcelain', '--untracked-files=all'])).stdout
  let preRestoreBackupStashCommit: string | undefined
  let preRestoreBackupStashMessage: string | undefined
  if (preRestoreStatus !== '') {
    preRestoreBackupStashMessage = `merlion-pre-undo:${record.sessionId}:${record.checkpointId}`
    await runGit(record.gitRoot, ['stash', 'push', '-u', '-m', preRestoreBackupStashMessage], { timeoutMs: 160_000 })
    preRestoreBackupStashCommit = (await runGit(record.gitRoot, ['rev-parse', '--verify', 'stash@{0}'])).stdout
  }

  await runGit(record.gitRoot, ['reset', '--hard'], { timeoutMs: 160_000 })
  await runGit(record.gitRoot, ['clean', '-fd'], { timeoutMs: 160_000 })
  if (record.mode === 'stash') {
    await runGit(record.gitRoot, ['stash', 'apply', '--index', record.refName], { timeoutMs: 200_000 })
  } else {
    await runGit(record.gitRoot, ['reset', '--hard', record.headCommit], { timeoutMs: 160_000 })
  }
  await deleteGitRef(record.gitRoot, record.refName)

  const restored: GitCheckpointRecord = {
    ...record,
    status: 'restored',
    restoredAt: new Date().toISOString(),
    preRestoreBackupStashCommit,
    preRestoreBackupStashMessage,
  }
  await writeCheckpointRecord(restored)
  await pruneCheckpointArtifacts(record.projectRoot, record.gitRoot)
  return restored
}
