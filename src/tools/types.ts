import type { SubagentToolRuntime } from '../runtime/subagent_types.ts'
import type { CapabilityProfileName, MutationPolicy, TaskKind } from '../runtime/task_state.ts'
import type { RuntimeSandboxEvent } from '../runtime/events.ts'
import type { SandboxViolation } from '../sandbox/backend.ts'
import type { SandboxBackend } from '../sandbox/backend.ts'
import type { ResolvedSandboxPolicy } from '../sandbox/policy.ts'

export interface EditDiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
}

export interface EditDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: EditDiffLine[]
}

export interface EditDiffUiPayload {
  kind: 'edit_diff'
  path: string
  addedLines: number
  removedLines: number
  hunks: EditDiffHunk[]
}

export type ToolUiPayload = EditDiffUiPayload
export type ToolSource = 'builtin' | 'mcp' | 'extension'
export type ToolGuidancePriority = 'normal' | 'critical'

export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestionItem {
  header: string
  id: string
  question: string
  options: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface ToolResult {
  content: string
  isError: boolean
  uiPayload?: ToolUiPayload
}

export type PermissionDecision = 'allow' | 'deny' | 'allow_session'

export interface PermissionRequest {
  phase?: 'preflight' | 'escalation'
  violationKind?: SandboxViolation['kind']
  sessionScope?: string
}

export interface PermissionStore {
  ask: (tool: string, description: string, request?: PermissionRequest) => Promise<PermissionDecision>
}

export interface ToolSummary {
  name: string
  description: string
  source?: ToolSource
  searchHint?: string
  modelGuidance?: string
  modelExamples?: string[]
  guidancePriority?: ToolGuidancePriority
  requiredParameters?: string[]
  isReadOnly?: boolean
  isDestructive?: boolean
  requiresUserInteraction?: boolean
  requiresTrustedWorkspace?: boolean
}

export interface ToolContext {
  cwd: string
  sessionId?: string
  permissions?: PermissionStore
  sandbox?: {
    policy: ResolvedSandboxPolicy
    backend: SandboxBackend
  }
  onSandboxEvent?: (event: RuntimeSandboxEvent) => void
  listTools?: () => ToolSummary[]
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  subagents?: SubagentToolRuntime
  taskControl?: {
    kind: TaskKind
    capabilityProfile: CapabilityProfileName
    mutationPolicy: MutationPolicy
  }
}

export interface ToolDefinition {
  name: string
  description: string
  source?: ToolSource
  searchHint?: string
  modelGuidance?: string
  modelExamples?: string[]
  guidancePriority?: ToolGuidancePriority
  isReadOnly?: boolean
  isDestructive?: boolean
  requiresUserInteraction?: boolean
  requiresTrustedWorkspace?: boolean
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  concurrencySafe: boolean
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
