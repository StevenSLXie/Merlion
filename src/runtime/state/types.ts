import type { ExecutionCharter } from '../execution_charter.ts'
import type { CapabilityProfileName, MutationPolicy, TaskState } from '../task_state.ts'

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
  task: {
    currentTask: TaskState | null
    capabilityProfile: CapabilityProfileName | null
    mutationPolicy: MutationPolicy | null
    charter: ExecutionCharter | null
  }
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
  task: {
    currentTask: TaskState | null
    capabilityProfile: CapabilityProfileName | null
    mutationPolicy: MutationPolicy | null
    charter: ExecutionCharter | null
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
    task: {
      currentTask: null,
      capabilityProfile: null,
      mutationPolicy: null,
      charter: null,
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
    task: {
      currentTask: state.task.currentTask
        ? {
            ...state.task.currentTask,
            explicitPaths: [...state.task.currentTask.explicitPaths],
            openQuestions: [...state.task.currentTask.openQuestions],
            correctionNotes: state.task.currentTask.correctionNotes ? [...state.task.currentTask.correctionNotes] : undefined,
          }
        : null,
      capabilityProfile: state.task.capabilityProfile,
      mutationPolicy: state.task.mutationPolicy
        ? {
            ...state.task.mutationPolicy,
            writableScopes: state.task.mutationPolicy.writableScopes
              ? [...state.task.mutationPolicy.writableScopes]
              : undefined,
          }
        : null,
      charter: state.task.charter
        ? {
            ...state.task.charter,
            nonGoals: [...state.task.charter.nonGoals],
            correctionNotes: state.task.charter.correctionNotes ? [...state.task.charter.correctionNotes] : undefined,
          }
        : null,
    },
  }
}
