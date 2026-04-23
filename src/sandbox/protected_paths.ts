import { join } from 'node:path'

import type { SessionFiles } from '../runtime/session.ts'
import { findProjectRoot } from '../artifacts/project_root.ts'

export interface SandboxProtectedPaths {
  denyRead: string[]
  denyWrite: string[]
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export async function deriveSandboxProtectedPaths(
  cwd: string,
  session?: SessionFiles,
): Promise<SandboxProtectedPaths> {
  const projectRoot = await findProjectRoot(cwd)
  const denyWrite = [
    join(projectRoot, '.merlion', 'sessions'),
    join(projectRoot, '.merlion', 'checkpoints'),
  ]
  const denyRead: string[] = []

  if (session) {
    denyWrite.push(session.transcriptPath, session.usagePath, session.childRegistryPath)
  }

  return {
    denyRead: uniqueSorted(denyRead),
    denyWrite: uniqueSorted(denyWrite),
  }
}
