import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { GUIDANCE_FILENAMES } from './agents.ts'
import { MANUAL_BEGIN, MANUAL_END } from './agents_auto.ts'
import { fileExists, findProjectRoot } from './project_root.ts'

export interface StaleGuidanceHint {
  guidanceFile: string
  scope: string
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || !rel.startsWith('..')
}

async function nearestProjectGuidance(root: string, startDir: string): Promise<string | null> {
  let cursor = resolve(startDir)
  for (;;) {
    for (const filename of GUIDANCE_FILENAMES) {
      const candidate = join(cursor, filename)
      if (await fileExists(candidate)) return candidate
    }
    if (cursor === root) return null
    const parent = resolve(cursor, '..')
    if (!isInside(root, parent) || parent === cursor) return null
    cursor = parent
  }
}

async function hasManualSection(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8')
    return content.includes(MANUAL_BEGIN) && content.includes(MANUAL_END)
  } catch {
    return false
  }
}

export async function detectPotentialStaleGuidance(
  cwd: string,
  changedPaths: string[]
): Promise<StaleGuidanceHint[]> {
  if (changedPaths.length === 0) return []

  const root = await findProjectRoot(cwd)
  const normalized = changedPaths
    .map((path) => resolve(cwd, path))
    .filter((path) => isInside(root, path))

  if (normalized.length === 0) return []

  const changedSet = new Set(normalized)
  const byGuidance = new Map<string, { scope: string; newestChangeMs: number }>()

  for (const changedFile of normalized) {
    const fileDir = dirname(changedFile)
    const guidance = await nearestProjectGuidance(root, fileDir)
    if (!guidance) continue

    if (changedSet.has(guidance)) continue
    if (!(await hasManualSection(guidance))) continue

    try {
      const changedStat = await stat(changedFile)
      const relScope = relative(root, dirname(guidance)).replace(/\\/g, '/') || '.'
      const existing = byGuidance.get(guidance)
      const newest = Math.max(existing?.newestChangeMs ?? 0, changedStat.mtimeMs)
      byGuidance.set(guidance, {
        scope: relScope,
        newestChangeMs: newest,
      })
    } catch {
      // Ignore missing temp paths.
    }
  }

  const hints: StaleGuidanceHint[] = []
  for (const [guidance, meta] of byGuidance.entries()) {
    try {
      const guidanceStat = await stat(guidance)
      if (meta.newestChangeMs <= guidanceStat.mtimeMs + 1000) continue
      hints.push({
        guidanceFile: relative(root, guidance).replace(/\\/g, '/'),
        scope: meta.scope,
      })
      if (hints.length >= 3) break
    } catch {
      // Ignore stale file stat errors.
    }
  }

  return hints
}
