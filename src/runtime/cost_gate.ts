import { readFile } from 'node:fs/promises'

import type { UsageDerivedMetrics, UsagePrimaryMetric } from './usage.ts'

export type CostGateMode = 'off' | 'warn' | 'fail'
export type CostGateSeverity = 'warn' | 'fail'
export type CostGateObservedMetric = UsagePrimaryMetric | 'total_tokens'

export interface CostBaselinePrimaryMetric {
  baselines: Partial<Record<UsagePrimaryMetric, number>>
  threshold_pct?: number
}

export interface CostBaselineGuardrail {
  baseline: number
  threshold_pct?: number
  severity?: CostGateSeverity
}

export interface CostBaselineScenario {
  primary_metric: CostBaselinePrimaryMetric
  guardrails?: {
    total_tokens?: CostBaselineGuardrail
  }
}

export interface CostBaseline {
  default_threshold_pct: number
  default_guardrail_severity: CostGateSeverity
  scenarios: Record<string, CostBaselineScenario>
}

export type CostGateDecision =
  | { status: 'skip'; message: string }
  | {
      status: 'pass' | 'warn' | 'fail'
      message: string
      selectedPrimaryMetric: UsagePrimaryMetric
      primaryMetricDegradedReason: string | null
      triggeredGate: 'primary' | 'guardrail' | null
      observedMetric: CostGateObservedMetric
      observedValue: number
      thresholdValue: number
      thresholdTokens?: number
    }

export function parseCostGateMode(raw: string | undefined): CostGateMode {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (normalized === 'off') return 'off'
  if (normalized === 'warn') return 'warn'
  return 'fail'
}

function isUsagePrimaryMetric(value: unknown): value is UsagePrimaryMetric {
  return value === 'estimated_cost_usd' || value === 'effective_total_tokens'
}

function isSeverity(value: unknown): value is CostGateSeverity {
  return value === 'warn' || value === 'fail'
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function normalizeMetricValue(metric: CostGateObservedMetric, value: number): number {
  return metric === 'estimated_cost_usd' ? value : Math.floor(value)
}

function formatMetricValue(metric: CostGateObservedMetric, value: number): string {
  return metric === 'estimated_cost_usd' ? `$${value.toFixed(6)}` : `${Math.floor(value)}`
}

function computeThreshold(metric: CostGateObservedMetric, baseline: number, thresholdPct: number): number {
  const rawThreshold = baseline * (1 + thresholdPct / 100)
  return metric === 'estimated_cost_usd' ? rawThreshold : Math.ceil(rawThreshold)
}

function resolveThresholdPct(raw: number | undefined, defaultThresholdPct: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultThresholdPct
  return Math.max(0, value)
}

function appendDegradedReason(message: string, degradedReason: string | null): string {
  return degradedReason === null ? message : `${message}, degraded_reason=${degradedReason}`
}

function buildPrimaryMessage(params: {
  scenario: string
  status: 'pass' | 'warn' | 'fail'
  metric: UsagePrimaryMetric
  observedValue: number
  thresholdValue: number
  baselineValue: number
  thresholdPct: number
  degradedReason: string | null
}): string {
  const prefix = params.status === 'pass' ? 'pass' : 'regression'
  const comparison = params.status === 'pass' ? '<=' : '>'
  return appendDegradedReason(
    `[cost-gate] ${prefix} ${params.scenario}: cost-primary metric ${params.metric} ` +
      `observed=${formatMetricValue(params.metric, params.observedValue)} ${comparison} ` +
      `threshold=${formatMetricValue(params.metric, params.thresholdValue)} ` +
      `(baseline=${formatMetricValue(params.metric, params.baselineValue)}, threshold_pct=${params.thresholdPct})`,
    params.degradedReason,
  )
}

function buildGuardrailMessage(params: {
  scenario: string
  observedValue: number
  thresholdValue: number
  baselineValue: number
  thresholdPct: number
  severity: CostGateSeverity
  selectedPrimaryMetric: UsagePrimaryMetric
  degradedReason: string | null
}): string {
  return appendDegradedReason(
    `[cost-gate] raw-token guardrail ${params.severity} ${params.scenario}: total_tokens ` +
      `observed=${formatMetricValue('total_tokens', params.observedValue)} > ` +
      `threshold=${formatMetricValue('total_tokens', params.thresholdValue)} ` +
      `(baseline=${formatMetricValue('total_tokens', params.baselineValue)}, threshold_pct=${params.thresholdPct}, ` +
      `primary_metric=${params.selectedPrimaryMetric})`,
    params.degradedReason,
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readPrimaryMetricBaselines(value: unknown): Partial<Record<UsagePrimaryMetric, number>> {
  if (!isObject(value)) return {}
  const baselines: Partial<Record<UsagePrimaryMetric, number>> = {}
  for (const [metric, baselineRaw] of Object.entries(value)) {
    if (!isUsagePrimaryMetric(metric)) continue
    const baseline = toNonNegativeNumber(baselineRaw)
    if (baseline === undefined) continue
    baselines[metric] = normalizeMetricValue(metric, baseline)
  }
  return baselines
}

function normalizeScenarioBaseline(
  item: unknown,
  defaultGuardrailSeverity: CostGateSeverity,
): CostBaselineScenario | null {
  if (!isObject(item)) return null

  const legacyTotalTokens = toNonNegativeNumber(item.total_tokens)
  const legacyThresholdPct = typeof item.threshold_pct === 'number' && Number.isFinite(item.threshold_pct)
    ? item.threshold_pct
    : undefined

  const primaryMetricRaw = isObject(item.primary_metric) ? item.primary_metric : null
  const primaryMetricThresholdPct = primaryMetricRaw && typeof primaryMetricRaw.threshold_pct === 'number' &&
    Number.isFinite(primaryMetricRaw.threshold_pct)
    ? primaryMetricRaw.threshold_pct
    : undefined
  const primaryMetricBaselines = primaryMetricRaw
    ? readPrimaryMetricBaselines(primaryMetricRaw.baselines)
    : {}

  if (legacyTotalTokens !== undefined && primaryMetricBaselines.effective_total_tokens === undefined) {
    primaryMetricBaselines.effective_total_tokens = normalizeMetricValue('effective_total_tokens', legacyTotalTokens)
  }

  if (Object.keys(primaryMetricBaselines).length === 0) {
    return null
  }

  const guardrails: CostBaselineScenario['guardrails'] = {}
  if (isObject(item.guardrails) && isObject(item.guardrails.total_tokens)) {
    const totalTokensGuardrail = item.guardrails.total_tokens
    const baseline = toNonNegativeNumber(totalTokensGuardrail.baseline)
    if (baseline !== undefined) {
      const thresholdPct =
        typeof totalTokensGuardrail.threshold_pct === 'number' && Number.isFinite(totalTokensGuardrail.threshold_pct)
          ? totalTokensGuardrail.threshold_pct
          : undefined
      guardrails.total_tokens = {
        baseline: normalizeMetricValue('total_tokens', baseline),
        threshold_pct: thresholdPct,
        severity: isSeverity(totalTokensGuardrail.severity)
          ? totalTokensGuardrail.severity
          : defaultGuardrailSeverity,
      }
    }
  } else if (legacyTotalTokens !== undefined) {
    guardrails.total_tokens = {
      baseline: normalizeMetricValue('total_tokens', legacyTotalTokens),
      threshold_pct: legacyThresholdPct,
      severity: defaultGuardrailSeverity,
    }
  }

  return {
    primary_metric: {
      baselines: primaryMetricBaselines,
      threshold_pct: primaryMetricThresholdPct ?? legacyThresholdPct,
    },
    guardrails: Object.keys(guardrails).length > 0 ? guardrails : undefined,
  }
}

function resolveObservedMetricValue(
  metric: UsagePrimaryMetric,
  derivedMetrics: UsageDerivedMetrics | undefined,
  totalTokens: number | undefined,
): number | undefined {
  if (metric === 'estimated_cost_usd') {
    const value = derivedMetrics?.estimated_cost_usd
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  }
  if (derivedMetrics) {
    return normalizeMetricValue(metric, derivedMetrics.effective_total_tokens)
  }
  if (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens >= 0) {
    // Compatibility path until all E2E callers pass shared derived totals.
    return normalizeMetricValue(metric, totalTokens)
  }
  return undefined
}

export function evaluateCostGate(params: {
  baseline: CostBaseline | null
  scenario: string
  totalTokens?: number
  derivedMetrics?: UsageDerivedMetrics
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

  const derivedMetrics = params.derivedMetrics
  const primaryBaselines = scenarioBaseline.primary_metric.baselines
  const preferredPrimaryMetric = derivedMetrics?.primary_metric
  const candidatePrimaryMetrics: UsagePrimaryMetric[] = preferredPrimaryMetric
    ? [
        preferredPrimaryMetric,
        ...Object.keys(primaryBaselines)
          .filter((metric): metric is UsagePrimaryMetric =>
            isUsagePrimaryMetric(metric) && metric !== preferredPrimaryMetric
          ),
      ]
    : (Object.keys(primaryBaselines).filter(isUsagePrimaryMetric) as UsagePrimaryMetric[])

  let selectedPrimaryMetric: UsagePrimaryMetric | null = null
  let primaryObservedValue: number | undefined
  let primaryBaselineValue: number | undefined

  for (const metric of candidatePrimaryMetrics) {
    const baselineValue = primaryBaselines[metric]
    if (baselineValue === undefined) continue
    const observedValue = resolveObservedMetricValue(metric, derivedMetrics, params.totalTokens)
    if (observedValue === undefined) continue
    selectedPrimaryMetric = metric
    primaryObservedValue = observedValue
    primaryBaselineValue = normalizeMetricValue(metric, baselineValue)
    break
  }

  if (
    selectedPrimaryMetric === null ||
    primaryObservedValue === undefined ||
    primaryBaselineValue === undefined
  ) {
    const availablePrimaryMetrics = Object.keys(primaryBaselines).filter(isUsagePrimaryMetric)
    return {
      status: 'skip',
      message:
        `[cost-gate] skipped (no observed primary metric for ${params.scenario}; ` +
        `baseline_metrics=${availablePrimaryMetrics.join(',') || 'none'})`,
    }
  }

  const primaryThresholdPct = resolveThresholdPct(
    scenarioBaseline.primary_metric.threshold_pct,
    params.baseline.default_threshold_pct,
  )
  const primaryThresholdValue = computeThreshold(
    selectedPrimaryMetric,
    primaryBaselineValue,
    primaryThresholdPct,
  )
  const primaryMetricDegradedReason = derivedMetrics?.primary_metric_degraded_reason ?? null

  if (primaryObservedValue > primaryThresholdValue) {
    const status = params.mode === 'warn' ? 'warn' : 'fail'
    return {
      status,
      selectedPrimaryMetric,
      primaryMetricDegradedReason,
      triggeredGate: 'primary',
      observedMetric: selectedPrimaryMetric,
      observedValue: primaryObservedValue,
      thresholdValue: primaryThresholdValue,
      thresholdTokens: selectedPrimaryMetric === 'estimated_cost_usd' ? undefined : primaryThresholdValue,
      message: buildPrimaryMessage({
        scenario: params.scenario,
        status,
        metric: selectedPrimaryMetric,
        observedValue: primaryObservedValue,
        thresholdValue: primaryThresholdValue,
        baselineValue: primaryBaselineValue,
        thresholdPct: primaryThresholdPct,
        degradedReason: primaryMetricDegradedReason,
      }),
    }
  }

  const normalizedTotalTokens =
    typeof params.totalTokens === 'number' && Number.isFinite(params.totalTokens) && params.totalTokens >= 0
      ? normalizeMetricValue('total_tokens', params.totalTokens)
      : undefined
  const totalTokensGuardrail = scenarioBaseline.guardrails?.total_tokens
  if (totalTokensGuardrail && normalizedTotalTokens !== undefined) {
    const guardrailThresholdPct = resolveThresholdPct(
      totalTokensGuardrail.threshold_pct,
      params.baseline.default_threshold_pct,
    )
    const guardrailThresholdValue = computeThreshold(
      'total_tokens',
      totalTokensGuardrail.baseline,
      guardrailThresholdPct,
    )

    if (normalizedTotalTokens > guardrailThresholdValue) {
      const guardrailSeverity = params.mode === 'warn'
        ? 'warn'
        : totalTokensGuardrail.severity ?? params.baseline.default_guardrail_severity
      return {
        status: guardrailSeverity,
        selectedPrimaryMetric,
        primaryMetricDegradedReason,
        triggeredGate: 'guardrail',
        observedMetric: 'total_tokens',
        observedValue: normalizedTotalTokens,
        thresholdValue: guardrailThresholdValue,
        thresholdTokens: guardrailThresholdValue,
        message: buildGuardrailMessage({
          scenario: params.scenario,
          observedValue: normalizedTotalTokens,
          thresholdValue: guardrailThresholdValue,
          baselineValue: totalTokensGuardrail.baseline,
          thresholdPct: guardrailThresholdPct,
          severity: guardrailSeverity,
          selectedPrimaryMetric,
          degradedReason: primaryMetricDegradedReason,
        }),
      }
    }
  }

  return {
    status: 'pass',
    selectedPrimaryMetric,
    primaryMetricDegradedReason,
    triggeredGate: null,
    observedMetric: selectedPrimaryMetric,
    observedValue: primaryObservedValue,
    thresholdValue: primaryThresholdValue,
    thresholdTokens: selectedPrimaryMetric === 'estimated_cost_usd' ? undefined : primaryThresholdValue,
    message: buildPrimaryMessage({
      scenario: params.scenario,
      status: 'pass',
      metric: selectedPrimaryMetric,
      observedValue: primaryObservedValue,
      thresholdValue: primaryThresholdValue,
      baselineValue: primaryBaselineValue,
      thresholdPct: primaryThresholdPct,
      degradedReason: primaryMetricDegradedReason,
    }),
  }
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
  const defaultGuardrailSeverity = isSeverity(parsed.default_guardrail_severity)
    ? parsed.default_guardrail_severity
    : 'warn'

  const scenarios: Record<string, CostBaselineScenario> = {}
  for (const [name, item] of Object.entries(parsed.scenarios)) {
    const normalized = normalizeScenarioBaseline(item, defaultGuardrailSeverity)
    if (!normalized) continue
    scenarios[name] = normalized
  }

  return {
    default_threshold_pct: defaultThreshold,
    default_guardrail_severity: defaultGuardrailSeverity,
    scenarios
  }
}
