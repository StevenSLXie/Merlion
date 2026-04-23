import { CliExperience } from '../../cli/experience.ts'
import type {
  RuntimeAssistantResponseEvent,
  RuntimeSandboxEvent,
  RuntimeSink,
  RuntimeToolResultEvent,
  RuntimeToolStartEvent,
  RuntimeTurnStartEvent,
  RuntimeUsageEvent,
} from '../events.ts'

export interface CliSinkOptions {
  model: string
  sessionId: string
  isRepl: boolean
}

export interface CliSinkDriver {
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
  onUsage(snapshot: RuntimeUsageEvent['snapshot'], estimatedCost?: number, provider?: string, promptObservability?: RuntimeUsageEvent['promptObservability']): void
  onPhaseUpdate(text: string): void
  onMapUpdated(text: string): void
  setToolDetailMode(mode: 'full' | 'compact'): void
}

export class CliRuntimeSink implements RuntimeSink {
  private readonly driver: CliSinkDriver

  constructor(options: CliSinkOptions, driver?: CliSinkDriver) {
    this.driver = driver ?? new CliExperience(options)
  }

  renderBanner(): void {
    this.driver.renderBanner()
  }

  renderUserPrompt(prompt: string): void {
    this.driver.renderUserPrompt(prompt)
  }

  renderAssistantOutput(output: string, terminal: string): void {
    this.driver.renderAssistantOutput(output, terminal)
  }

  clearTypedInputLine(): void {
    this.driver.clearTypedInputLine()
  }

  stopSpinner(): void {
    this.driver.stopSpinner()
  }

  promptLabel(): string {
    return this.driver.promptLabel()
  }

  onTurnStart(event: RuntimeTurnStartEvent): void {
    this.driver.onTurnStart(event)
  }

  onAssistantResponse(event: RuntimeAssistantResponseEvent): void {
    this.driver.onAssistantResponse(event)
  }

  onToolStart(event: RuntimeToolStartEvent): void {
    this.driver.onToolStart(event)
  }

  onToolResult(event: RuntimeToolResultEvent): void {
    this.driver.onToolResult(event)
  }

  onUsage(event: RuntimeUsageEvent): void {
    this.driver.onUsage(event.snapshot, event.estimatedCost, event.provider, event.promptObservability)
  }

  onPhaseUpdate(text: string): void {
    this.driver.onPhaseUpdate(text)
  }

  onMapUpdated(text: string): void {
    this.driver.onMapUpdated(text)
  }

  onSandboxEvent(event: RuntimeSandboxEvent): void {
    if (event.type === 'sandbox.warning') {
      this.driver.onPhaseUpdate(`[sandbox] warning: ${event.summary ?? 'sandbox runtime warning'}`)
      return
    }
    if (event.type === 'sandbox.violation') {
      this.driver.onPhaseUpdate(
        `[sandbox] ${event.toolName} blocked by ${event.violationKind ?? 'policy'} on ${event.backend}`
      )
      return
    }
    if (event.type === 'sandbox.escalation.requested') {
      this.driver.onPhaseUpdate(
        `[sandbox] requesting broader access for ${event.toolName} (${event.violationKind ?? 'policy'})`
      )
      return
    }
    if (event.type === 'sandbox.escalation.allowed') {
      this.driver.onPhaseUpdate(
        `[sandbox] broader access allowed for ${event.toolName} (${event.violationKind ?? 'policy'})`
      )
      return
    }
    if (event.type === 'sandbox.escalation.denied') {
      this.driver.onPhaseUpdate(
        `[sandbox] broader access denied for ${event.toolName} (${event.violationKind ?? 'policy'})`
      )
      return
    }
  }

  setToolDetailMode(mode: 'full' | 'compact'): void {
    this.driver.setToolDetailMode(mode)
  }
}
