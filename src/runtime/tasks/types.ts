import type { RunLoopResult } from '../loop.ts'
import type { UserInputEnvelope } from '../input/types.ts'
import type { QueryEngine } from '../query_engine.ts'
import type { VerificationRunResult } from '../../verification/runner.ts'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RuntimeTaskContext {
  engine: QueryEngine
}

export interface RuntimeTaskHandler<Input, Output> {
  type: string
  run(input: Input, ctx: RuntimeTaskContext): Promise<Output>
}

export interface LocalTurnTaskInput {
  envelope: UserInputEnvelope
  executeSlashCommand: (name: string, raw: string) => Promise<{ output: string; terminal: string }>
  executeShellShortcut: (command: string) => Promise<{ output: string; terminal: string }>
}

export interface LocalTurnTaskOutput {
  output: string
  terminal: string
  loopResult?: RunLoopResult
}

export interface VerificationTaskInput {
  runVerification: () => Promise<VerificationRunResult>
  runFixTurn: (prompt: string, round: number) => Promise<void>
  onRound?: (event: { round: number; action: 'fix' | 'pass' | 'stop' }) => Promise<void> | void
  maxRounds: number
}

export interface VerificationTaskOutput {
  passed: boolean
}

export interface WechatMessageTaskInput {
  text: string
  renderReply: (result: RunLoopResult) => string
}

export interface WechatMessageTaskOutput {
  result: RunLoopResult
  reply: string
}
