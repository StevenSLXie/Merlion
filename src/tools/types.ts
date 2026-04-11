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

export interface ToolResult {
  content: string
  isError: boolean
  uiPayload?: ToolUiPayload
}

export type PermissionDecision = 'allow' | 'deny' | 'allow_session'

export interface PermissionStore {
  ask: (tool: string, description: string) => Promise<PermissionDecision>
}

export interface ToolContext {
  cwd: string
  sessionId?: string
  permissions?: PermissionStore
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  concurrencySafe: boolean
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
