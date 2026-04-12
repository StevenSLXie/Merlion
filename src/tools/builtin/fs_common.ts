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

function validatePathShape(pathInput: string): string | null {
  const trimmed = pathInput.trim()
  if (trimmed === '') return 'Invalid path: expected non-empty string.'
  if (trimmed.length > 1024) return 'Invalid path: too long.'
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return 'Invalid path: contains control characters.'
  }
  if (/\u001b\[[0-9;]*m/.test(trimmed)) {
    return 'Invalid path: contains terminal escape sequences.'
  }
  if (/^[=:;,\[\]{}<>`"'|]+$/.test(trimmed)) {
    return 'Invalid path: appears to be a placeholder or malformed token.'
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return 'Invalid path: shell home shorthand (`~/`) is not supported; use a workspace-relative path.'
  }
  if (trimmed.includes('{{') || trimmed.includes('}}') || trimmed.includes('${')) {
    return 'Invalid path: appears to contain unresolved template placeholders.'
  }
  return null
}

export function validateAndResolveWorkspacePath(
  cwd: string,
  pathInput: unknown
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof pathInput !== 'string' || pathInput.trim() === '') {
    return { ok: false, error: 'Invalid path: expected non-empty string.' }
  }
  const shapeError = validatePathShape(pathInput)
  if (shapeError) return { ok: false, error: shapeError }
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
