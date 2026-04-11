import type { UsageSnapshot } from '../runtime/usage.ts'
import type { PromptObservabilitySnapshot } from '../runtime/prompt_observability.ts'

function formatInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n)))
}

function formatPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0.0%'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function formatSignedInt(n: number): string {
  const value = Math.floor(n)
  if (value > 0) return `+${formatInt(value)}`
  if (value < 0) return `-${formatInt(Math.abs(value))}`
  return '0'
}

export function formatCliStatusLine(
  snapshot: UsageSnapshot,
  estimatedCost?: number,
  provider?: string
): string {
  const cachedPct = formatPct(snapshot.totals.cached_tokens, snapshot.totals.prompt_tokens)
  const parts = [
    `turn ${snapshot.turn}`,
    `Δ in ${formatInt(snapshot.delta.prompt_tokens)} out ${formatInt(snapshot.delta.completion_tokens)} cached ${formatInt(snapshot.delta.cached_tokens)}`,
    `Σ in ${formatInt(snapshot.totals.prompt_tokens)} out ${formatInt(snapshot.totals.completion_tokens)} cached ${formatInt(snapshot.totals.cached_tokens)} (${cachedPct} input cached)`,
  ]
  if (snapshot.turn >= 3 && snapshot.totals.cached_tokens === 0) {
    parts.push('no cache hits yet (model/provider may not support caching)')
  }
  if (provider && provider.trim() !== '') {
    parts.push(`provider ${provider}`)
  }
  if (typeof estimatedCost === 'number' && Number.isFinite(estimatedCost) && estimatedCost >= 0) {
    parts.push(`est $${estimatedCost.toFixed(6)}`)
  }
  return `status · ${parts.join(' · ')}`
}

export function formatPromptObservabilityLine(
  snapshot: UsageSnapshot,
  prompt: PromptObservabilitySnapshot | undefined
): string {
  if (!prompt) return ''
  const cachedTurn = Math.min(
    Math.max(0, Math.floor(snapshot.delta.cached_tokens)),
    Math.max(0, Math.floor(prompt.estimated_input_tokens))
  )
  const prefixPct = formatPct(prompt.stable_prefix_tokens, prompt.estimated_input_tokens)
  const providerPct = formatPct(cachedTurn, prompt.estimated_input_tokens)
  const parts = [
    `prompt ~${formatInt(prompt.estimated_input_tokens)} tok (tools ~${formatInt(prompt.tool_schema_tokens_estimate)})`,
    `roles s ${formatInt(prompt.role_tokens.system)} u ${formatInt(prompt.role_tokens.user)} a ${formatInt(prompt.role_tokens.assistant)} t ${formatInt(prompt.role_tokens.tool)}`,
    `Δroles s ${formatSignedInt(prompt.role_delta_tokens.system)} u ${formatSignedInt(prompt.role_delta_tokens.user)} a ${formatSignedInt(prompt.role_delta_tokens.assistant)} t ${formatSignedInt(prompt.role_delta_tokens.tool)}`,
    `stable ${formatInt(prompt.stable_prefix_tokens)} (${prefixPct})`,
    `provider-cache turn ${formatInt(cachedTurn)} (${providerPct})`,
    `hash ${prompt.stable_prefix_hash ?? 'none'}`
  ]
  return `prompt · ${parts.join(' · ')}`
}
