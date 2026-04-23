import { isAbsolute, relative, resolve } from 'node:path'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type NetworkMode = 'off' | 'full'
export type LegacyPermissionMode = 'interactive' | 'auto_allow' | 'auto_deny'

export interface MerlionSandboxConfig {
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  networkMode?: NetworkMode
  writableRoots?: string[]
  denyRead?: string[]
  denyWrite?: string[]
}

export interface ResolvedSandboxPolicy {
  mode: SandboxMode
  approvalPolicy: ApprovalPolicy
  networkMode: NetworkMode
  cwd: string
  writableRoots: string[]
  denyRead: string[]
  denyWrite: string[]
}

export interface ResolveSandboxPolicyOptions extends MerlionSandboxConfig {
  cwd: string
  fixedDenyRead?: string[]
  fixedDenyWrite?: string[]
}

export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write'
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'on-failure'
export const DEFAULT_NETWORK_MODE: NetworkMode = 'off'

function normalizePathList(cwd: string, values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  const deduped = new Set<string>()
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    deduped.add(resolve(cwd, trimmed))
  }
  return [...deduped].sort()
}

export function approvalPolicyFromLegacyPermissionMode(
  mode: LegacyPermissionMode | undefined,
): ApprovalPolicy {
  if (mode === 'auto_allow') return 'never'
  if (mode === 'auto_deny') return 'untrusted'
  return DEFAULT_APPROVAL_POLICY
}

export function resolveSandboxPolicy(options: ResolveSandboxPolicyOptions): ResolvedSandboxPolicy {
  const cwd = resolve(options.cwd)
  const mode = options.sandboxMode ?? DEFAULT_SANDBOX_MODE
  const approvalPolicy = options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY
  const networkMode = options.networkMode ?? DEFAULT_NETWORK_MODE
  const writableRoots = normalizePathList(cwd, options.writableRoots)
  const denyRead = normalizePathList(cwd, [...(options.denyRead ?? []), ...(options.fixedDenyRead ?? [])])
  const denyWrite = normalizePathList(cwd, [...(options.denyWrite ?? []), ...(options.fixedDenyWrite ?? [])])

  if (mode === 'workspace-write' && writableRoots.length === 0) {
    writableRoots.unshift(cwd)
  }

  return {
    mode,
    approvalPolicy,
    networkMode,
    cwd,
    writableRoots,
    denyRead,
    denyWrite,
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function createUnsandboxedPolicy(cwd: string): ResolvedSandboxPolicy {
  return resolveSandboxPolicy({
    cwd,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    networkMode: 'full',
  })
}

export function widenSandboxPolicy(
  policy: ResolvedSandboxPolicy,
  kind: 'fs-write' | 'fs-read' | 'network' | 'policy' | 'backend',
): ResolvedSandboxPolicy {
  if (policy.mode === 'danger-full-access' && policy.networkMode === 'full') {
    return policy
  }

  return resolveSandboxPolicy({
    cwd: policy.cwd,
    sandboxMode: 'workspace-write',
    approvalPolicy: policy.approvalPolicy,
    networkMode: kind === 'network' || kind === 'backend' ? 'full' : policy.networkMode,
    writableRoots: ['/'],
    denyRead: kind === 'fs-read' || kind === 'policy' || kind === 'backend' ? [] : policy.denyRead,
    denyWrite: policy.denyWrite,
  })
}

export function isPathReadDenied(policy: ResolvedSandboxPolicy, candidatePath: string): boolean {
  if (policy.mode === 'danger-full-access') return false
  const target = resolve(candidatePath)
  return policy.denyRead.some((root) => pathWithin(root, target))
}

export function isPathWriteAllowed(policy: ResolvedSandboxPolicy, candidatePath: string): boolean {
  if (policy.mode === 'danger-full-access') return true
  if (policy.mode === 'read-only') return false
  const target = resolve(candidatePath)
  if (policy.denyWrite.some((root) => pathWithin(root, target))) return false
  return policy.writableRoots.some((root) => pathWithin(root, target))
}

export function describePolicyViolation(
  policy: ResolvedSandboxPolicy,
  candidatePath: string,
): string {
  if (policy.mode === 'read-only') {
    return 'Current sandbox is read-only and does not permit file mutations.'
  }
  const target = resolve(candidatePath)
  if (policy.denyWrite.some((root) => pathWithin(root, target))) {
    return 'Path is blocked by sandbox deny-write policy.'
  }
  return 'Path is outside the current sandbox writable roots.'
}
