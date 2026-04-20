import type { LoopState } from '../../types.js'
import type { CompactState } from './types.ts'

export function syncCompactStateFromLoopState(state: CompactState, loopState: LoopState): void {
  state.hasAttemptedReactiveCompact = loopState.hasAttemptedReactiveCompact
  if (loopState.hasAttemptedReactiveCompact) {
    state.lastCompactBoundaryCount = loopState.messages.length
  }
}

export function recordFinalSummary(state: CompactState, summary: string): void {
  const trimmed = summary.trim()
  if (trimmed !== '') state.lastSummaryText = trimmed
}
