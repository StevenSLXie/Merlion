export type ContextTrustLevel = 'trusted' | 'untrusted'

export interface ContextTrustOptions {
  permissionMode?: 'interactive' | 'auto_allow' | 'auto_deny'
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
}

export function resolveContextTrustLevel(options: ContextTrustOptions): ContextTrustLevel {
  const override = process.env.MERLION_TRUST_WORKSPACE?.trim().toLowerCase()
  if (override === '0' || override === 'false' || override === 'no') return 'untrusted'
  if (override === '1' || override === 'true' || override === 'yes') return 'trusted'
  if (options.sandboxMode === 'read-only' && (options.approvalPolicy === 'untrusted' || options.approvalPolicy === 'never')) {
    return 'untrusted'
  }
  return options.permissionMode === 'auto_deny' ? 'untrusted' : 'trusted'
}

export function shouldPrefetchExpensiveContext(level: ContextTrustLevel): boolean {
  return level === 'trusted'
}
