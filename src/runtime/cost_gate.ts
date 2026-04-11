import { readFile } from 'node:fs/promises'

export type CostGateMode = 'off' | 'warn' | 'fail'

export interface CostBaselineScenario {
  total_tokens: number
  threshold_pct?: number
}

export interface CostBaseline {
  default_threshold_pct: number
  scenarios: Record<string, CostBaselineScenario>
}

export type CostGateDecision =
  | { status: 'skip'; message: string }
  | { status: 'pass'; message: string; thresholdTokens: number }
  | { status: 'warn'; message: string; thresholdTokens: number }
  | { status: 'fail'; message: string; thresholdTokens: number }

export function parseCostGateMode(raw: string | undefined): CostGateMode {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (normalized === 'off') return 'off'
  if (normalized === 'warn') return 'warn'
  return 'fail'
}

export function evaluateCostGate(params: {
  baseline: CostBaseline | null
  scenario: string
  totalTokens: number
  mode: CostGateMode
}): CostGateDecision {
  if (params.mode === 'off') {
    return { status: 'skip', message: '[cost-gate] skipped (mode=off)' }
  }
  if (!params.baseline) {
    return { status: 'skip', message: '[cost-gate] skipped (no baseline loaded)' }
  }

  const scenarioBaseline = params.baseline.scenarios[params.scenario]
  if (!scenarioBaseline) {
    return { status: 'skip', message: `[cost-gate] skipped (no baseline for ${params.scenario})` }
  }

  const thresholdPct = Number.isFinite(scenarioBaseline.threshold_pct)
    ? Math.max(0, scenarioBaseline.threshold_pct!)
    : Math.max(0, params.baseline.default_threshold_pct)
  const baselineTokens = Math.max(0, Math.floor(scenarioBaseline.total_tokens))
  const thresholdTokens = Math.ceil(baselineTokens * (1 + thresholdPct / 100))
  const totalTokens = Math.max(0, Math.floor(params.totalTokens))

  if (totalTokens <= thresholdTokens) {
    return {
      status: 'pass',
      thresholdTokens,
      message: `[cost-gate] pass ${params.scenario}: total=${totalTokens}, threshold=${thresholdTokens}`
    }
  }

  const message =
    `[cost-gate] regression ${params.scenario}: total=${totalTokens} > threshold=${thresholdTokens} ` +
    `(baseline=${baselineTokens}, threshold_pct=${thresholdPct})`

  if (params.mode === 'warn') {
    return { status: 'warn', thresholdTokens, message }
  }
  return { status: 'fail', thresholdTokens, message }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function readCostBaseline(path: string): Promise<CostBaseline | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  if (!isObject(parsed.scenarios)) return null
  const defaultThresholdRaw = parsed.default_threshold_pct
  const defaultThreshold = typeof defaultThresholdRaw === 'number' && Number.isFinite(defaultThresholdRaw)
    ? defaultThresholdRaw
    : 20

  const scenarios: Record<string, CostBaselineScenario> = {}
  for (const [name, item] of Object.entries(parsed.scenarios)) {
    if (!isObject(item)) continue
    const totalRaw = item.total_tokens
    if (typeof totalRaw !== 'number' || !Number.isFinite(totalRaw)) continue
    const thresholdRaw = item.threshold_pct
    scenarios[name] = {
      total_tokens: totalRaw,
      threshold_pct: typeof thresholdRaw === 'number' && Number.isFinite(thresholdRaw) ? thresholdRaw : undefined
    }
  }

  return {
    default_threshold_pct: defaultThreshold,
    scenarios
  }
}
