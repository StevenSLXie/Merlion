import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'

import { findProjectRoot } from './project_root.ts'
import { updateProgressArtifact } from './progress.ts'

export interface AutoProgressSignals {
  changedPaths: string[]
  sawSuccessfulGitCommit: boolean
}

export interface AutoProgressResult {
  updated: boolean
  lines: string[]
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}

function normalizeChangedPaths(root: string, cwd: string, paths: string[]): string[] {
  const normalized = paths
    .map((path) => relative(root, resolve(cwd, path)).replace(/\\/g, '/'))
    .filter((path) => path !== '' && !path.startsWith('..'))

  const unique: string[] = []
  for (const path of normalized) {
    if (!unique.includes(path)) unique.push(path)
    if (unique.length >= 16) break
  }
  return unique
}

function summarizeChangedFiles(paths: string[]): string {
  if (paths.length === 0) return ''
  const shown = paths.slice(0, 4)
  const remaining = paths.length - shown.length
  const suffix = remaining > 0 ? ` (+${remaining} more)` : ''
  return `${shown.join(', ')}${suffix}`
}

function latestCommitSummary(root: string): string {
  return runGit(root, ['log', '--date=short', '--pretty=format:%ad %h %s', '-n', '1'])
}

export async function updateProgressFromRuntimeSignals(
  cwd: string,
  signals: AutoProgressSignals
): Promise<AutoProgressResult> {
  const root = await findProjectRoot(cwd)
  const timestamp = new Date().toISOString().slice(0, 10)
  const changed = normalizeChangedPaths(root, cwd, signals.changedPaths)

  const doneLines: string[] = []

  if (signals.sawSuccessfulGitCommit) {
    const commit = latestCommitSummary(root)
    doneLines.push(commit !== '' ? `[${timestamp}] Commit: ${commit}` : `[${timestamp}] Commit completed.`)
  } else if (changed.length > 0) {
    doneLines.push(`[${timestamp}] Changed files: ${summarizeChangedFiles(changed)}`)
  }

  if (doneLines.length === 0) {
    return { updated: false, lines: [] }
  }

  await updateProgressArtifact(cwd, {
    done: doneLines,
  })

  return {
    updated: true,
    lines: doneLines,
  }
}
