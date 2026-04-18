import type { VerificationRunResult } from '../verification/runner.ts'
import { runVerificationFixRounds } from '../verification/fix_round.ts'

export interface VerificationRoundRequest {
  runVerification: () => Promise<VerificationRunResult>
  runFixTurn: (prompt: string, round: number) => Promise<void>
  onRound?: (event: { round: number; action: 'fix' | 'pass' | 'stop' }) => Promise<void> | void
  maxRounds: number
}

export interface VerificationRoundResult {
  passed: boolean
}

export async function executeVerificationRound(
  input: VerificationRoundRequest,
): Promise<VerificationRoundResult> {
  const outcome = await runVerificationFixRounds({
    maxRounds: input.maxRounds,
    runVerification: input.runVerification,
    runFixTurn: input.runFixTurn,
    onRound: input.onRound
      ? async ({ round, action }) => {
          await input.onRound?.({ round, action })
        }
      : undefined,
  })
  return { passed: outcome.passed }
}
