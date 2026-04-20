export type SubagentRole = 'explorer' | 'worker' | 'verifier'

export type AgentVerdict = 'pass' | 'fail' | 'partial' | 'not_applicable'

export type ChildAgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface AgentRunResult {
  agentId: string
  role: SubagentRole
  status: ChildAgentStatus
  summary: string
  finalText?: string
  filesRead?: string[]
  filesChanged?: string[]
  commandsRun?: string[]
  transcriptPath: string
  usage?: {
    promptTokens: number
    completionTokens: number
    cachedTokens?: number | null
  }
  verification?: {
    verdict: AgentVerdict
    notes?: string[]
  }
  error?: string
}

export interface SpawnAgentInput {
  role: SubagentRole
  task: string
  execution?: 'foreground' | 'background'
  purpose?: string
  writeScope?: string[]
  model?: string
  timeoutMs?: number
}

export interface SpawnAgentRejectedResult {
  status: 'rejected'
  reason: 'capacity_limit_exceeded' | 'background_not_supported' | 'depth_limit_exceeded'
  maxConcurrentChildren?: number
  runningChildren?: number
  suggestedRetryAfterSeconds: number
}

export interface SpawnAgentBackgroundResult {
  agentId: string
  role: SubagentRole
  status: 'running'
  summary: string
  transcriptPath: string
}

export type SpawnAgentResult = AgentRunResult | SpawnAgentBackgroundResult | SpawnAgentRejectedResult

export interface WaitAgentRunningResult {
  agentId: string
  status: 'running'
  suggestedRetryAfterSeconds: number
}

export type WaitAgentResult = AgentRunResult | WaitAgentRunningResult

export interface WaitAgentInput {
  agentId: string
}

export interface AgentBriefing {
  parentSessionId: string
  parentAgentId?: string
  role: SubagentRole
  originalUserRequest: string
  rootUserRequest?: string
  task: string
  purpose?: string
  parentSummary?: string
  relevantPaths?: string[]
  changedFiles?: string[]
  constraints?: string[]
  writeScope?: string[]
  verificationTarget?: {
    changedFiles: string[]
    acceptanceCriteria?: string[]
  }
}

export interface ChildAgentRecord {
  agentId: string
  parentSessionId: string
  parentDepth: number
  childDepth: number
  role: SubagentRole
  execution: 'foreground' | 'background'
  status: ChildAgentStatus
  childSessionId: string
  transcriptPath: string
  timeoutMs: number
  startedAt: string
  finishedAt?: string
  task: string
  purpose?: string
  model?: string
  summary: string
  finalText?: string
  filesRead?: string[]
  filesChanged?: string[]
  commandsRun?: string[]
  verification?: {
    verdict: AgentVerdict
    notes?: string[]
  }
  error?: string
}

export interface SubagentToolRuntime {
  spawnAgent: (input: SpawnAgentInput) => Promise<SpawnAgentResult>
  waitAgent: (agentId: string) => Promise<WaitAgentResult>
}

export interface SubagentRuntimeContext {
  prompt: string
  historyLength: number
  sessionId?: string
  model?: string
  depth: number
}
