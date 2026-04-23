import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import type { SandboxViolation } from '../../sandbox/backend.ts'
import {
  describePolicyViolation,
  isPathReadDenied,
  isPathWriteAllowed,
  widenSandboxPolicy,
} from '../../sandbox/policy.ts'
import type { PermissionRequest } from '../types.ts'
import type { ToolContext } from '../types.ts'

function emitSandboxEvent(
  ctx: ToolContext,
  event: {
    type: 'sandbox.violation' | 'sandbox.escalation.requested' | 'sandbox.escalation.denied' | 'sandbox.escalation.allowed'
    toolName: string
    summary?: string
    violationKind?: SandboxViolation['kind']
  },
): void {
  const policy = ctx.sandbox?.policy
  const backend = ctx.sandbox?.backend
  if (!policy || !backend) return
  ctx.onSandboxEvent?.({
    type: event.type,
    backend: backend.name(),
    sessionId: ctx.sessionId,
    sandboxMode: policy.mode,
    approvalPolicy: policy.approvalPolicy,
    toolName: event.toolName,
    summary: event.summary,
    violationKind: event.violationKind,
  })
}

export function isWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = resolve(workspaceRoot)
  const target = resolve(candidatePath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathContains(root: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(root)
  const target = resolve(candidatePath)
  const rel = relative(normalizedRoot, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function resolveWorkspacePath(cwd: string, pathInput: string): string {
  return isAbsolute(pathInput) ? resolve(pathInput) : resolve(cwd, pathInput)
}

async function lstatIfExists(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch {
    return null
  }
}

async function realpathIfExists(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    return targetPath
  }
}

async function realWorkspaceRoot(cwd: string): Promise<string> {
  return await realpathIfExists(resolve(cwd))
}

async function nearestExistingAncestor(targetPath: string): Promise<string> {
  let current = resolve(targetPath)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await lstatIfExists(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

async function canonicalizePotentiallyMissingPath(targetPath: string): Promise<string> {
  const existingAncestor = await nearestExistingAncestor(targetPath)
  const realAncestor = await realpathIfExists(existingAncestor)
  const suffix = relative(existingAncestor, resolve(targetPath))
  return suffix === '' ? resolve(realAncestor) : resolve(realAncestor, suffix)
}

function rebaseCanonicalPath(canonicalPath: string, lexicalRoot: string, canonicalRoot: string): string {
  if (!isWithinWorkspace(canonicalRoot, canonicalPath)) return canonicalPath
  const suffix = relative(canonicalRoot, canonicalPath)
  return suffix === '' ? lexicalRoot : resolve(lexicalRoot, suffix)
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

export async function resolveReadTargetPath(
  cwd: string,
  pathInput: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const validated = validateAndResolveWorkspacePath(cwd, pathInput)
  if (!validated.ok) return validated
  const lexicalRoot = resolve(cwd)
  const canonicalRoot = await realWorkspaceRoot(cwd)
  const st = await lstatIfExists(validated.path)
  if (st?.isSymbolicLink()) {
    return { ok: false, error: 'Symlink targets are not supported by fs tools.' }
  }
  const canonicalPath = await canonicalizePotentiallyMissingPath(validated.path)
  if (!isWithinWorkspace(canonicalRoot, canonicalPath)) {
    return { ok: false, error: 'Path resolves outside the workspace root and cannot be accessed.' }
  }
  return { ok: true, path: rebaseCanonicalPath(canonicalPath, lexicalRoot, canonicalRoot) }
}

export async function resolveMutationTargetPath(
  cwd: string,
  pathInput: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const validated = validateAndResolveWorkspacePath(cwd, pathInput)
  if (!validated.ok) return validated
  const lexicalRoot = resolve(cwd)
  const canonicalRoot = await realWorkspaceRoot(cwd)
  const st = await lstatIfExists(validated.path)
  if (st?.isSymbolicLink()) {
    return { ok: false, error: 'Symlink targets are not supported by fs tools.' }
  }
  const canonicalPath = await canonicalizePotentiallyMissingPath(validated.path)
  if (!isWithinWorkspace(canonicalRoot, canonicalPath)) {
    return { ok: false, error: 'Path resolves outside the workspace root and cannot be modified.' }
  }
  return { ok: true, path: rebaseCanonicalPath(canonicalPath, lexicalRoot, canonicalRoot) }
}

export function enforceMutationPolicy(
  ctx: ToolContext,
  targetPath: string,
): { ok: true } | { ok: false; error: string } {
  const policy = ctx.sandbox?.policy
  if (!policy) return { ok: true }
  if (isPathWriteAllowed(policy, targetPath)) return { ok: true }
  return { ok: false, error: describePolicyViolation(policy, targetPath) }
}

export function enforceReadPolicy(
  ctx: ToolContext,
  targetPath: string,
): { ok: true } | { ok: false; error: string } {
  const policy = ctx.sandbox?.policy
  if (!policy) return { ok: true }
  if (!isPathReadDenied(policy, targetPath)) return { ok: true }
  return { ok: false, error: 'Path is blocked by sandbox deny-read policy.' }
}

export function enforceReadDiscoveryPolicy(
  ctx: ToolContext,
  targetPath: string,
): { ok: true } | { ok: false; error: string } {
  const direct = enforceReadPolicy(ctx, targetPath)
  if (!direct.ok) return direct

  const policy = ctx.sandbox?.policy
  if (!policy) return { ok: true }
  const resolvedTarget = resolve(targetPath)
  if (policy.denyRead.some((deniedPath) => pathContains(resolvedTarget, deniedPath))) {
    return {
      ok: false,
      error: 'Path contains sandbox-protected descendants and cannot be listed or searched.',
    }
  }
  return { ok: true }
}

export function isReadDeniedPath(ctx: ToolContext, targetPath: string): boolean {
  const policy = ctx.sandbox?.policy
  if (!policy) return false
  return isPathReadDenied(policy, targetPath)
}

async function requestPermission(
  ctx: ToolContext,
  toolName: string,
  description: string,
  request?: PermissionRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const decision = await ctx.permissions?.ask(toolName, description, request)
  if (decision === 'deny' || decision === undefined) {
    return { ok: false, error: '[Permission denied]' }
  }
  return { ok: true }
}

function permissionScope(toolName: string, kind: SandboxViolation['kind']): string {
  return `${toolName}:${kind}`
}

function canEscalateMutation(policy: NonNullable<ToolContext['sandbox']>['policy'], targetPath: string): boolean {
  return isPathWriteAllowed(widenSandboxPolicy(policy, 'fs-write'), targetPath)
}

export async function authorizeMutation(
  ctx: ToolContext,
  toolName: string,
  targetPath: string,
  description: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const policy = ctx.sandbox?.policy
  if (!policy) {
    return await requestPermission(ctx, toolName, description, {
      phase: 'preflight',
      violationKind: 'fs-write',
      sessionScope: permissionScope(toolName, 'fs-write'),
    })
  }

  const allowed = enforceMutationPolicy(ctx, targetPath)
  if (allowed.ok) {
    if (policy.approvalPolicy !== 'on-request') return allowed
    return await requestPermission(ctx, toolName, description, {
      phase: 'preflight',
      violationKind: 'fs-write',
      sessionScope: permissionScope(toolName, 'fs-write'),
    })
  }
  if (policy.approvalPolicy !== 'on-failure' && policy.approvalPolicy !== 'on-request') {
    return allowed
  }

  emitSandboxEvent(ctx, {
    type: 'sandbox.violation',
    toolName,
    summary: description,
    violationKind: 'fs-write',
  })
  if (!canEscalateMutation(policy, targetPath)) {
    return { ok: false, error: describePolicyViolation(widenSandboxPolicy(policy, 'fs-write'), targetPath) }
  }

  emitSandboxEvent(ctx, {
    type: 'sandbox.escalation.requested',
    toolName,
    summary: description,
    violationKind: 'fs-write',
  })
  const permission = await requestPermission(ctx, toolName, `Request broader sandbox access: ${description}`, {
    phase: 'escalation',
    violationKind: 'fs-write',
    sessionScope: permissionScope(toolName, 'fs-write'),
  })
  if (!permission.ok) {
    emitSandboxEvent(ctx, {
      type: 'sandbox.escalation.denied',
      toolName,
      summary: description,
      violationKind: 'fs-write',
    })
    return permission
  }

  emitSandboxEvent(ctx, {
    type: 'sandbox.escalation.allowed',
    toolName,
    summary: description,
    violationKind: 'fs-write',
  })

  return { ok: true }
}

export async function authorizeNetworkAccess(
  ctx: ToolContext,
  toolName: string,
  description: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const policy = ctx.sandbox?.policy
  if (!policy) return { ok: true }

  if (policy.mode === 'danger-full-access' || policy.networkMode === 'full') {
    if (policy.approvalPolicy !== 'on-request') return { ok: true }
    return await requestPermission(ctx, toolName, description, {
      phase: 'preflight',
      violationKind: 'network',
      sessionScope: permissionScope(toolName, 'network'),
    })
  }

  if (policy.approvalPolicy === 'on-request') {
    return await requestPermission(ctx, toolName, description, {
      phase: 'preflight',
      violationKind: 'network',
      sessionScope: permissionScope(toolName, 'network'),
    })
  }
  if (policy.approvalPolicy !== 'on-failure') {
    return { ok: false, error: 'Current sandbox blocks outbound network access.' }
  }

  emitSandboxEvent(ctx, {
    type: 'sandbox.violation',
    toolName,
    summary: description,
    violationKind: 'network',
  })
  emitSandboxEvent(ctx, {
    type: 'sandbox.escalation.requested',
    toolName,
    summary: description,
    violationKind: 'network',
  })
  const permission = await requestPermission(ctx, toolName, `Request broader sandbox access: ${description}`, {
    phase: 'escalation',
    violationKind: 'network',
    sessionScope: permissionScope(toolName, 'network'),
  })
  if (!permission.ok) {
    emitSandboxEvent(ctx, {
      type: 'sandbox.escalation.denied',
      toolName,
      summary: description,
      violationKind: 'network',
    })
    return permission
  }
  emitSandboxEvent(ctx, {
    type: 'sandbox.escalation.allowed',
    toolName,
    summary: description,
    violationKind: 'network',
  })
  return { ok: true }
}

export function parsePositiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const parsed = Math.floor(value)
  if (parsed < min) return min
  if (parsed > max) return max
  return parsed
}
