export interface ToolResult {
  content: string
  isError: boolean
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
