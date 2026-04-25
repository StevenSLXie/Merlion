import type { ExecutionCharter } from '../execution_charter.ts'
import type { CapabilityProfileName, MutationPolicy, SchemaChangeReason, TaskState } from '../task_state.ts'

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
    profileEpoch: {
      epoch: number
      lastSchemaChangeReason: SchemaChangeReason | null
      pendingResumeRehydration: boolean
    }
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
    profileEpoch: {
      epoch: number
      lastSchemaChangeReason: SchemaChangeReason | null
      pendingResumeRehydration: boolean
    }
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
      profileEpoch: {
        epoch: 0,
        lastSchemaChangeReason: null,
        pendingResumeRehydration: false,
      },
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
      profileEpoch: {
        epoch: state.task.profileEpoch.epoch,
        lastSchemaChangeReason: state.task.profileEpoch.lastSchemaChangeReason,
        pendingResumeRehydration: state.task.profileEpoch.pendingResumeRehydration,
      },
    },
  }
}

export function restoreRuntimeState(state: RuntimeState, snapshot: RuntimeStateSnapshot): void {
  state.permissions.deniedToolNames = new Set(snapshot.permissions.deniedToolNames)
  state.permissions.deniedToolSignatures = new Set(snapshot.permissions.deniedToolSignatures)
  state.permissions.sessionAllowedScopes = new Set(snapshot.permissions.sessionAllowedScopes)
  state.permissions.lastDecision = snapshot.permissions.lastDecision

  state.compact.hasAttemptedReactiveCompact = snapshot.compact.hasAttemptedReactiveCompact
  state.compact.lastCompactBoundaryCount = snapshot.compact.lastCompactBoundaryCount
  state.compact.lastSummaryText = snapshot.compact.lastSummaryText

  state.task.currentTask = snapshot.task.currentTask
    ? {
        ...snapshot.task.currentTask,
        explicitPaths: [...snapshot.task.currentTask.explicitPaths],
        openQuestions: [...snapshot.task.currentTask.openQuestions],
        correctionNotes: snapshot.task.currentTask.correctionNotes
          ? [...snapshot.task.currentTask.correctionNotes]
          : undefined,
      }
    : null
  state.task.capabilityProfile = snapshot.task.capabilityProfile
  state.task.mutationPolicy = snapshot.task.mutationPolicy
    ? {
        ...snapshot.task.mutationPolicy,
        writableScopes: snapshot.task.mutationPolicy.writableScopes
          ? [...snapshot.task.mutationPolicy.writableScopes]
          : undefined,
      }
    : null
  state.task.charter = snapshot.task.charter
    ? {
        ...snapshot.task.charter,
        nonGoals: [...snapshot.task.charter.nonGoals],
        correctionNotes: snapshot.task.charter.correctionNotes
          ? [...snapshot.task.charter.correctionNotes]
          : undefined,
      }
    : null
  state.task.profileEpoch = {
    epoch: snapshot.task.profileEpoch.epoch,
    lastSchemaChangeReason: snapshot.task.profileEpoch.lastSchemaChangeReason,
    pendingResumeRehydration: snapshot.task.profileEpoch.pendingResumeRehydration,
  }
}
