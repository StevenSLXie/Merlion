import { isAbsolute, relative, resolve } from 'node:path'

export function isWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = resolve(workspaceRoot)
  const target = resolve(candidatePath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function resolveWorkspacePath(cwd: string, pathInput: string): string {
  return isAbsolute(pathInput) ? resolve(pathInput) : resolve(cwd, pathInput)
}

export function validateAndResolveWorkspacePath(
  cwd: string,
  pathInput: unknown
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof pathInput !== 'string' || pathInput.trim() === '') {
    return { ok: false, error: 'Invalid path: expected non-empty string.' }
  }
  const resolved = resolveWorkspacePath(cwd, pathInput)
  if (!isWithinWorkspace(cwd, resolved)) {
    return { ok: false, error: 'Path is outside the workspace root and cannot be modified.' }
  }
  return { ok: true, path: resolved }
}

export function parsePositiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const parsed = Math.floor(value)
  if (parsed < min) return min
  if (parsed > max) return max
  return parsed
}
