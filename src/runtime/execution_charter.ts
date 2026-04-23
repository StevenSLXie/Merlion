import type { CapabilityProfileName, MutationPolicy, TaskState } from './task_state.ts'

export interface ExecutionCharter {
  objective: string
  nonGoals: string[]
  deliverable: string
  toolProfile: CapabilityProfileName
  mutationPolicy: 'forbidden' | 'scoped' | 'allowed'
  evidenceStandard: string
  reviewScope?: string
  correctionNotes?: string[]
}

function evidenceStandardText(taskState: TaskState): string {
  switch (taskState.requiredEvidence) {
    case 'verified':
      return 'Run concrete verification and report what passed or failed.'
    case 'diffbacked':
      return 'Base conclusions on concrete diffs or changed files.'
    case 'codebacked':
      return 'Cite concrete files, modules, or symbols before concluding.'
    case 'light':
    default:
      return 'Answer directly and keep evidence proportional to the question.'
  }
}

export function buildExecutionCharter(
  taskState: TaskState,
  capabilityProfile: CapabilityProfileName,
  mutationPolicy: MutationPolicy,
): ExecutionCharter {
  return {
    objective: taskState.activeObjective,
    nonGoals: mutationPolicy.mayMutateFiles ? [] : ['Do not change files or perform destructive shell actions.'],
    deliverable: taskState.expectedDeliverable,
    toolProfile: capabilityProfile,
    mutationPolicy: mutationPolicy.mayMutateFiles
      ? (mutationPolicy.writableScopes && mutationPolicy.writableScopes.length > 0 ? 'scoped' : 'allowed')
      : 'forbidden',
    evidenceStandard: evidenceStandardText(taskState),
    reviewScope: taskState.reviewScope,
    correctionNotes: taskState.correctionOfPreviousTurn ? taskState.correctionNotes ?? [] : undefined,
  }
}

export function renderExecutionCharter(taskState: TaskState, charter: ExecutionCharter): string {
  const lines = [
    'Execution charter for this turn:',
    `- Task kind: ${taskState.kind}`,
    `- Objective: ${charter.objective}`,
    `- Deliverable: ${charter.deliverable}`,
    `- Tool profile: ${charter.toolProfile}`,
    `- Mutation policy: ${charter.mutationPolicy}`,
    `- Evidence standard: ${charter.evidenceStandard}`,
  ]

  if (charter.reviewScope) lines.push(`- Review scope: ${charter.reviewScope}`)
  if (taskState.explicitPaths.length > 0) {
    lines.push(`- Explicit paths: ${taskState.explicitPaths.join(', ')}`)
  }
  if (charter.correctionNotes && charter.correctionNotes.length > 0) {
    for (const note of charter.correctionNotes) {
      lines.push(`- Correction note: ${note}`)
    }
  }
  if (taskState.inheritedObjective) {
    lines.push(`- Previous objective replaced: ${taskState.inheritedObjective}`)
  }
  return lines.join('\n')
}
