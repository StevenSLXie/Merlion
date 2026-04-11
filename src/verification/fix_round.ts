import type { VerificationCheckResult, VerificationRunResult } from './runner.ts'

export interface FixRoundOptions {
  maxRounds: number
  runVerification: () => Promise<VerificationRunResult>
  runFixTurn: (prompt: string, round: number) => Promise<void>
  onRound?: (event: {
    round: number
    verification: VerificationRunResult
    action: 'pass' | 'fix' | 'stop'
    prompt?: string
  }) => Promise<void> | void
}

export interface FixRoundOutcome {
  passed: boolean
  roundsUsed: number
  lastVerification: VerificationRunResult | null
}

function cleanOutput(output: string, maxChars = 1200): string {
  const normalized = output.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

export function buildVerificationFixPrompt(round: number, failed: VerificationCheckResult[]): string {
  const summary = failed
    .map((item) => {
      const signal = cleanOutput(item.output)
      return `- ${item.name} (${item.command})\n  failure signal: ${signal || '(no output)'}`
    })
    .join('\n')

  return [
    `Verification failed after the previous attempt (fix round ${round}).`,
    'Address the failed checks below with minimal, safe edits.',
    'After edits, summarize what changed and why it should pass.',
    '',
    'Failed checks:',
    summary,
  ].join('\n')
}

export async function runVerificationFixRounds(options: FixRoundOptions): Promise<FixRoundOutcome> {
  const maxRounds = Math.max(0, Math.floor(options.maxRounds))
  let roundsUsed = 0
  let lastVerification: VerificationRunResult | null = null

  for (let round = 0; round <= maxRounds; round += 1) {
    const verification = await options.runVerification()
    lastVerification = verification
    if (verification.allPassed) {
      await options.onRound?.({
        round,
        verification,
        action: 'pass',
      })
      return { passed: true, roundsUsed, lastVerification }
    }

    const failed = verification.results.filter((r) => r.status === 'failed')
    if (round >= maxRounds || failed.length === 0) {
      await options.onRound?.({
        round,
        verification,
        action: 'stop',
      })
      return { passed: false, roundsUsed, lastVerification }
    }

    const prompt = buildVerificationFixPrompt(round + 1, failed)
    await options.onRound?.({
      round,
      verification,
      action: 'fix',
      prompt,
    })
    await options.runFixTurn(prompt, round + 1)
    roundsUsed += 1
  }

  return { passed: false, roundsUsed, lastVerification }
}
