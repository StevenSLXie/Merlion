export interface ToolResult {
  content: string
  isError: boolean
}

export interface ToolContext {
  cwd: string
  sessionId?: string
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

