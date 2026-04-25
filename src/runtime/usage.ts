export interface UsageLike {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens?: number | null
}

export interface UsageTotals {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
}

export interface UsageSnapshot {
  turn: number
  delta: UsageTotals
  totals: UsageTotals
}

export interface UsageRates {
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion?: number
}

export interface UsageSampleSummary {
  totals: UsageTotals
  sample_count: number
  has_missing_cached_tokens: boolean
}

export type UsagePrimaryMetric = 'estimated_cost_usd' | 'effective_total_tokens'

export interface UsageDerivedMetrics {
  uncached_prompt_tokens: number
  cached_prompt_ratio: number
  effective_input_tokens: number
  effective_total_tokens: number
  estimated_cost_usd?: number
  primary_metric: UsagePrimaryMetric
  primary_metric_value: number
  primary_metric_degraded_reason: string | null
}

export const USAGE_METRIC_DEGRADED_REASON_CACHED_TOKENS_UNAVAILABLE = 'cached_tokens_unavailable'

function toNumberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseEnvNumber(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function hasCachedTokensValue(usage: UsageLike): boolean {
  return typeof usage.cached_tokens === 'number' && Number.isFinite(usage.cached_tokens)
}

function normalizedUsage(usage: UsageLike): UsageTotals {
  const prompt = Math.max(0, Math.floor(toNumberOrZero(usage.prompt_tokens)))
  const completion = Math.max(0, Math.floor(toNumberOrZero(usage.completion_tokens)))
  const cachedRaw = Math.max(0, Math.floor(toNumberOrZero(usage.cached_tokens)))
  const cached = Math.min(prompt, cachedRaw)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    total_tokens: prompt + completion,
  }
}

export function resolveUsageRatesFromEnv(
  env: Record<string, string | undefined> = process.env,
): UsageRates | undefined {
  const input = parseEnvNumber(env, 'MERLION_COST_INPUT_PER_1M')
  const output = parseEnvNumber(env, 'MERLION_COST_OUTPUT_PER_1M')
  if (input === undefined || output === undefined) return undefined
  const cached = parseEnvNumber(env, 'MERLION_COST_CACHED_INPUT_PER_1M')
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cachedInputPerMillion: cached,
  }
}

export function summarizeUsageSamples(samples: Iterable<UsageLike>): UsageSampleSummary {
  const totals: UsageTotals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  }
  let sampleCount = 0
  let hasMissingCachedTokens = false

  for (const sample of samples) {
    sampleCount += 1
    if (!hasCachedTokensValue(sample)) {
      hasMissingCachedTokens = true
    }
    const normalized = normalizedUsage(sample)
    totals.prompt_tokens += normalized.prompt_tokens
    totals.completion_tokens += normalized.completion_tokens
    totals.cached_tokens += normalized.cached_tokens
  }

  totals.total_tokens = totals.prompt_tokens + totals.completion_tokens
  return {
    totals,
    sample_count: sampleCount,
    has_missing_cached_tokens: hasMissingCachedTokens,
  }
}

export function calculateUsageCostUsd(totals: UsageTotals, rates: UsageRates): number {
  const inputRate = Math.max(0, rates.inputPerMillion)
  const outputRate = Math.max(0, rates.outputPerMillion)
  const cachedRate = Math.max(0, rates.cachedInputPerMillion ?? inputRate)

  const cached = Math.min(totals.cached_tokens, totals.prompt_tokens)
  const nonCachedPrompt = Math.max(0, totals.prompt_tokens - cached)

  const promptCost = (nonCachedPrompt * inputRate) / 1_000_000
  const cachedCost = (cached * cachedRate) / 1_000_000
  const outputCost = (totals.completion_tokens * outputRate) / 1_000_000
  return promptCost + cachedCost + outputCost
}

export function deriveUsageMetrics(
  summary: UsageSampleSummary,
  rates?: UsageRates,
): UsageDerivedMetrics {
  const totals = summary.totals
  const degradedReason = summary.has_missing_cached_tokens
    ? USAGE_METRIC_DEGRADED_REASON_CACHED_TOKENS_UNAVAILABLE
    : null
  const cacheableCachedTokens = degradedReason === null ? totals.cached_tokens : 0
  const uncachedPromptTokens = Math.max(0, totals.prompt_tokens - cacheableCachedTokens)
  const cachedPromptRatio =
    degradedReason === null && totals.prompt_tokens > 0
      ? cacheableCachedTokens / totals.prompt_tokens
      : 0
  const effectiveInputTokens = uncachedPromptTokens
  const effectiveTotalTokens = effectiveInputTokens + totals.completion_tokens
  const estimatedCostUsd = rates
    ? calculateUsageCostUsd(
        {
          ...totals,
          cached_tokens: cacheableCachedTokens,
        },
        rates,
      )
    : undefined

  return {
    uncached_prompt_tokens: uncachedPromptTokens,
    cached_prompt_ratio: cachedPromptRatio,
    effective_input_tokens: effectiveInputTokens,
    effective_total_tokens: effectiveTotalTokens,
    estimated_cost_usd: estimatedCostUsd,
    primary_metric: estimatedCostUsd === undefined ? 'effective_total_tokens' : 'estimated_cost_usd',
    primary_metric_value: estimatedCostUsd === undefined ? effectiveTotalTokens : estimatedCostUsd,
    primary_metric_degraded_reason: degradedReason,
  }
}

export function formatUsageProgressLine(snapshot: UsageSnapshot, estimatedCostUsd?: number): string {
  const base =
    `[usage] turn ${snapshot.turn} ` +
    `+in ${snapshot.delta.prompt_tokens} ` +
    `+out ${snapshot.delta.completion_tokens} ` +
    `+cached ${snapshot.delta.cached_tokens} | ` +
    `total in ${snapshot.totals.prompt_tokens} ` +
    `out ${snapshot.totals.completion_tokens} ` +
    `cached ${snapshot.totals.cached_tokens}`

  if (typeof estimatedCostUsd !== 'number' || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    return base
  }
  return `${base} | est $${estimatedCostUsd.toFixed(6)}`
}

export function createUsageTracker(initial?: Partial<UsageTotals>) {
  let turn = 0
  const totals: UsageTotals = {
    prompt_tokens: Math.max(0, Math.floor(toNumberOrZero(initial?.prompt_tokens))),
    completion_tokens: Math.max(0, Math.floor(toNumberOrZero(initial?.completion_tokens))),
    cached_tokens: Math.max(0, Math.floor(toNumberOrZero(initial?.cached_tokens))),
    total_tokens: 0,
  }
  let sampleCount = 0
  let hasMissingCachedTokens = false
  totals.total_tokens = totals.prompt_tokens + totals.completion_tokens

  return {
    record(usage: UsageLike): UsageSnapshot {
      turn += 1
      sampleCount += 1
      if (!hasCachedTokensValue(usage)) {
        hasMissingCachedTokens = true
      }
      const delta = normalizedUsage(usage)
      totals.prompt_tokens += delta.prompt_tokens
      totals.completion_tokens += delta.completion_tokens
      totals.cached_tokens += delta.cached_tokens
      totals.total_tokens = totals.prompt_tokens + totals.completion_tokens
      return {
        turn,
        delta,
        totals: { ...totals },
      }
    },
    getTotals(): UsageTotals {
      return { ...totals }
    },
    getTurn(): number {
      return turn
    },
    getSummary(): UsageSampleSummary {
      return {
        totals: { ...totals },
        sample_count: sampleCount,
        has_missing_cached_tokens: hasMissingCachedTokens,
      }
    },
    getDerivedMetrics(rates?: UsageRates): UsageDerivedMetrics {
      return deriveUsageMetrics(this.getSummary(), rates)
    },
  }
}
