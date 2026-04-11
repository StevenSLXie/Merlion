import type { UsageSnapshot } from '../runtime/usage.ts'

function formatInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n)))
}

function formatPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0.0%'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

export function formatCliStatusLine(snapshot: UsageSnapshot, estimatedCost?: number): string {
  const cachedPct = formatPct(snapshot.totals.cached_tokens, snapshot.totals.prompt_tokens)
  const parts = [
    `turn ${snapshot.turn}`,
    `Δ in ${formatInt(snapshot.delta.prompt_tokens)} out ${formatInt(snapshot.delta.completion_tokens)} cached ${formatInt(snapshot.delta.cached_tokens)}`,
    `Σ in ${formatInt(snapshot.totals.prompt_tokens)} out ${formatInt(snapshot.totals.completion_tokens)} cached ${formatInt(snapshot.totals.cached_tokens)} (${cachedPct} input cached)`,
  ]
  if (typeof estimatedCost === 'number' && Number.isFinite(estimatedCost) && estimatedCost >= 0) {
    parts.push(`est $${estimatedCost.toFixed(6)}`)
  }
  return `status · ${parts.join(' · ')}`
}
