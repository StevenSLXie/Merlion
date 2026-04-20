import type { PromptObservabilitySnapshot } from './prompt_observability.ts'
import type { UsageSnapshot } from './usage.ts'
import type { ToolUiPayload } from '../tools/types.ts'

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
  setToolDetailMode(mode: 'full' | 'compact'): void
}
