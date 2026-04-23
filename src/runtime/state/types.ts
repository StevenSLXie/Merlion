export interface PermissionDecisionRecord {
  tool: string
  description: string
  scope: string
  decision: 'allow' | 'deny' | 'allow_session'
  at: string
}

export interface PermissionState {
  deniedToolNames: Set<string>
  deniedToolSignatures: Set<string>
  sessionAllowedScopes: Set<string>
  lastDecision: PermissionDecisionRecord | null
}

export interface CompactState {
  hasAttemptedReactiveCompact: boolean
  lastCompactBoundaryCount: number | null
  lastSummaryText: string | null
}

export interface RuntimeState {
  permissions: PermissionState
  compact: CompactState
}

export interface RuntimeStateSnapshot {
  permissions: {
    deniedToolNames: string[]
    deniedToolSignatures: string[]
    sessionAllowedScopes: string[]
    lastDecision: PermissionDecisionRecord | null
  }
  compact: {
    hasAttemptedReactiveCompact: boolean
    lastCompactBoundaryCount: number | null
    lastSummaryText: string | null
  }
}

export function createRuntimeState(): RuntimeState {
  return {
    permissions: {
      deniedToolNames: new Set<string>(),
      deniedToolSignatures: new Set<string>(),
      sessionAllowedScopes: new Set<string>(),
      lastDecision: null,
    },
    compact: {
      hasAttemptedReactiveCompact: false,
      lastCompactBoundaryCount: null,
      lastSummaryText: null,
    },
  }
}

export function snapshotRuntimeState(state: RuntimeState): RuntimeStateSnapshot {
  return {
    permissions: {
      deniedToolNames: [...state.permissions.deniedToolNames].sort(),
      deniedToolSignatures: [...state.permissions.deniedToolSignatures].sort(),
      sessionAllowedScopes: [...state.permissions.sessionAllowedScopes].sort(),
      lastDecision: state.permissions.lastDecision,
    },
    compact: {
      hasAttemptedReactiveCompact: state.compact.hasAttemptedReactiveCompact,
      lastCompactBoundaryCount: state.compact.lastCompactBoundaryCount,
      lastSummaryText: state.compact.lastSummaryText,
    },
  }
}
