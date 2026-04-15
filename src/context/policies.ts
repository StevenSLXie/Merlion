export type ContextTrustLevel = 'trusted' | 'untrusted'

export interface ContextTrustOptions {
  permissionMode?: 'interactive' | 'auto_allow' | 'auto_deny'
}

export function resolveContextTrustLevel(options: ContextTrustOptions): ContextTrustLevel {
  const override = process.env.MERLION_TRUST_WORKSPACE?.trim().toLowerCase()
  if (override === '0' || override === 'false' || override === 'no') return 'untrusted'
  if (override === '1' || override === 'true' || override === 'yes') return 'trusted'
  return options.permissionMode === 'auto_deny' ? 'untrusted' : 'trusted'
}

export function shouldPrefetchExpensiveContext(level: ContextTrustLevel): boolean {
  return level === 'trusted'
}
