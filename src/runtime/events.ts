import type { PromptObservabilitySnapshot } from './prompt_observability.ts'
import type { UsageSnapshot } from './usage.ts'
import type { ToolUiPayload } from '../tools/types.ts'
import type { ApprovalPolicy, SandboxMode } from '../sandbox/policy.ts'

export interface RuntimeTurnStartEvent {
  turn: number
}

export interface RuntimeAssistantResponseEvent {
  turn: number
  finish_reason: string
  tool_calls_count: number
}

export interface RuntimeToolStartEvent {
  index: number
  total: number
  name: string
  summary?: string
}

export interface RuntimeToolResultEvent {
  index: number
  total: number
  name: string
  durationMs: number
  isError: boolean
  uiPayload?: ToolUiPayload
}

export interface RuntimeUsageEvent {
  snapshot: UsageSnapshot
  estimatedCost?: number
  provider?: string
  promptObservability?: PromptObservabilitySnapshot
  runtimeResponseId?: string
  providerResponseId?: string
  providerFinishReason?: string
}

export interface RuntimeSandboxEvent {
  type:
    | 'sandbox.backend.selected'
    | 'sandbox.warning'
    | 'sandbox.command.started'
    | 'sandbox.command.completed'
    | 'sandbox.violation'
    | 'sandbox.escalation.requested'
    | 'sandbox.escalation.denied'
    | 'sandbox.escalation.allowed'
  backend: string
  sessionId?: string
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
  toolName: string
  summary?: string
  violationKind?: 'fs-read' | 'fs-write' | 'network' | 'policy' | 'backend'
}

export interface RuntimeSink {
  renderBanner(): void
  renderUserPrompt(prompt: string): void
  renderAssistantOutput(output: string, terminal: string): void
  clearTypedInputLine(): void
  stopSpinner(): void
  promptLabel(): string
  onTurnStart(event: RuntimeTurnStartEvent): void
  onAssistantResponse(event: RuntimeAssistantResponseEvent): void
  onToolStart(event: RuntimeToolStartEvent): void
  onToolResult(event: RuntimeToolResultEvent): void
  onUsage(event: RuntimeUsageEvent): void
  onPhaseUpdate(text: string): void
  onMapUpdated(text: string): void
  onSandboxEvent?(event: RuntimeSandboxEvent): void
  setToolDetailMode(mode: 'full' | 'compact'): void
}
