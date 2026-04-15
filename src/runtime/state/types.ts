import type { ChatMessage } from '../../types.js'

export interface PermissionDecisionRecord {
  tool: string
  description: string
  decision: 'allow' | 'deny' | 'allow_session'
  at: string
}

export interface PermissionState {
  deniedToolNames: Set<string>
  deniedToolSignatures: Set<string>
  sessionAllowedToolNames: Set<string>
  lastDecision: PermissionDecisionRecord | null
}

export interface CompactState {
  hasAttemptedReactiveCompact: boolean
  lastCompactBoundaryMessageCount: number | null
  replayedInjectedMessages: ChatMessage[]
  lastSummaryText: string | null
}

export interface SkillState {
  discoveredSkillNames: Set<string>
  activatedSkillNames: Set<string>
  injectedSkillPayloadIds: Set<string>
  activationCounts: Map<string, number>
}

export interface MemoryState {
  loadedMemoryPaths: Set<string>
  nestedMemoryExpansions: Set<string>
  sourceProvenance: Map<string, string>
}

export interface RuntimeState {
  permissions: PermissionState
  compact: CompactState
  skills: SkillState
  memory: MemoryState
}

export interface RuntimeStateSnapshot {
  permissions: {
    deniedToolNames: string[]
    deniedToolSignatures: string[]
    sessionAllowedToolNames: string[]
    lastDecision: PermissionDecisionRecord | null
  }
  compact: {
    hasAttemptedReactiveCompact: boolean
    lastCompactBoundaryMessageCount: number | null
    replayedInjectedMessages: ChatMessage[]
    lastSummaryText: string | null
  }
  skills: {
    discoveredSkillNames: string[]
    activatedSkillNames: string[]
    injectedSkillPayloadIds: string[]
    activationCounts: Array<{ name: string; count: number }>
  }
  memory: {
    loadedMemoryPaths: string[]
    nestedMemoryExpansions: string[]
    sourceProvenance: Array<{ path: string; source: string }>
  }
}

export function createRuntimeState(): RuntimeState {
  return {
    permissions: {
      deniedToolNames: new Set<string>(),
      deniedToolSignatures: new Set<string>(),
      sessionAllowedToolNames: new Set<string>(),
      lastDecision: null,
    },
    compact: {
      hasAttemptedReactiveCompact: false,
      lastCompactBoundaryMessageCount: null,
      replayedInjectedMessages: [],
      lastSummaryText: null,
    },
    skills: {
      discoveredSkillNames: new Set<string>(),
      activatedSkillNames: new Set<string>(),
      injectedSkillPayloadIds: new Set<string>(),
      activationCounts: new Map<string, number>(),
    },
    memory: {
      loadedMemoryPaths: new Set<string>(),
      nestedMemoryExpansions: new Set<string>(),
      sourceProvenance: new Map<string, string>(),
    },
  }
}

export function snapshotRuntimeState(state: RuntimeState): RuntimeStateSnapshot {
  return {
    permissions: {
      deniedToolNames: [...state.permissions.deniedToolNames].sort(),
      deniedToolSignatures: [...state.permissions.deniedToolSignatures].sort(),
      sessionAllowedToolNames: [...state.permissions.sessionAllowedToolNames].sort(),
      lastDecision: state.permissions.lastDecision,
    },
    compact: {
      hasAttemptedReactiveCompact: state.compact.hasAttemptedReactiveCompact,
      lastCompactBoundaryMessageCount: state.compact.lastCompactBoundaryMessageCount,
      replayedInjectedMessages: [...state.compact.replayedInjectedMessages],
      lastSummaryText: state.compact.lastSummaryText,
    },
    skills: {
      discoveredSkillNames: [...state.skills.discoveredSkillNames].sort(),
      activatedSkillNames: [...state.skills.activatedSkillNames].sort(),
      injectedSkillPayloadIds: [...state.skills.injectedSkillPayloadIds].sort(),
      activationCounts: [...state.skills.activationCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    memory: {
      loadedMemoryPaths: [...state.memory.loadedMemoryPaths].sort(),
      nestedMemoryExpansions: [...state.memory.nestedMemoryExpansions].sort(),
      sourceProvenance: [...state.memory.sourceProvenance.entries()]
        .map(([path, source]) => ({ path, source }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    },
  }
}
