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

function toNumberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
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
  totals.total_tokens = totals.prompt_tokens + totals.completion_tokens

  return {
    record(usage: UsageLike): UsageSnapshot {
      turn += 1
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
  }
}
