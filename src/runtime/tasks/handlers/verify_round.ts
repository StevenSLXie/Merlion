import { runVerificationFixRounds } from '../../../verification/fix_round.ts'
import type { RuntimeTaskHandler, VerificationTaskInput, VerificationTaskOutput } from '../types.ts'

export const verificationTaskHandler: RuntimeTaskHandler<VerificationTaskInput, VerificationTaskOutput> = {
  type: 'verify_round',
  async run(input) {
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
  },
}
