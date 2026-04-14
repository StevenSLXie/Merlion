import { CliExperience } from '../../cli/experience.ts'
import type {
  RuntimeAssistantResponseEvent,
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

  setToolDetailMode(mode: 'full' | 'compact'): void {
    this.driver.setToolDetailMode(mode)
  }
}
