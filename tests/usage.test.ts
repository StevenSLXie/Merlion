import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateUsageCostUsd,
  createUsageTracker,
  deriveUsageMetrics,
  formatUsageProgressLine,
  resolveUsageRatesFromEnv,
  summarizeUsageSamples,
  USAGE_METRIC_DEGRADED_REASON_CACHED_TOKENS_UNAVAILABLE,
} from '../src/runtime/usage.ts'

test('usage tracker accumulates prompt/completion/cached tokens', () => {
  const tracker = createUsageTracker()

  const first = tracker.record({
    prompt_tokens: 120,
    completion_tokens: 30,
    cached_tokens: 20,
  })
  assert.equal(first.turn, 1)
  assert.equal(first.delta.prompt_tokens, 120)
  assert.equal(first.delta.completion_tokens, 30)
  assert.equal(first.delta.cached_tokens, 20)
  assert.equal(first.totals.total_tokens, 150)

  const second = tracker.record({
    prompt_tokens: 80,
    completion_tokens: 40,
    cached_tokens: null,
  })
  assert.equal(second.turn, 2)
  assert.equal(second.totals.prompt_tokens, 200)
  assert.equal(second.totals.completion_tokens, 70)
  assert.equal(second.totals.cached_tokens, 20)
  assert.equal(second.totals.total_tokens, 270)
})

test('formatUsageProgressLine prints delta and totals', () => {
  const tracker = createUsageTracker()
  const snapshot = tracker.record({
    prompt_tokens: 10,
    completion_tokens: 5,
    cached_tokens: 1,
  })

  const line = formatUsageProgressLine(snapshot)
  assert.match(line, /\[usage\]/)
  assert.match(line, /\+in 10/)
  assert.match(line, /\+out 5/)
  assert.match(line, /\+cached 1/)
  assert.match(line, /total in 10/)
})

test('calculateUsageCostUsd handles cached tokens as discounted input', () => {
  const cost = calculateUsageCostUsd(
    {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cached_tokens: 200,
      total_tokens: 1500,
    },
    {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cachedInputPerMillion: 0.25,
    },
  )

  const expected = ((800 * 2.5) + (200 * 0.25) + (500 * 10)) / 1_000_000
  assert.equal(Number(cost.toFixed(12)), Number(expected.toFixed(12)))
})

test('resolveUsageRatesFromEnv reads the shared pricing env contract', () => {
  const rates = resolveUsageRatesFromEnv({
    MERLION_COST_INPUT_PER_1M: '2.5',
    MERLION_COST_OUTPUT_PER_1M: '10',
    MERLION_COST_CACHED_INPUT_PER_1M: '0.25',
  })

  assert.deepEqual(rates, {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.25,
  })
})

test('deriveUsageMetrics selects estimated_cost_usd when shared rates are available', () => {
  const metrics = deriveUsageMetrics(
    summarizeUsageSamples([
      { prompt_tokens: 500, completion_tokens: 50, cached_tokens: 200 },
      { prompt_tokens: 300, completion_tokens: 20, cached_tokens: 100 },
    ]),
    {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cachedInputPerMillion: 0.25,
    },
  )

  const expectedCost = ((500 * 2.5) + (300 * 0.25) + (70 * 10)) / 1_000_000
  assert.equal(metrics.uncached_prompt_tokens, 500)
  assert.equal(metrics.cached_prompt_ratio, 300 / 800)
  assert.equal(metrics.effective_input_tokens, 500)
  assert.equal(metrics.effective_total_tokens, 570)
  assert.equal(Number(metrics.estimated_cost_usd!.toFixed(12)), Number(expectedCost.toFixed(12)))
  assert.equal(metrics.primary_metric, 'estimated_cost_usd')
  assert.equal(Number(metrics.primary_metric_value.toFixed(12)), Number(expectedCost.toFixed(12)))
  assert.equal(metrics.primary_metric_degraded_reason, null)
})

test('deriveUsageMetrics falls back to effective_total_tokens without shared rates', () => {
  const metrics = deriveUsageMetrics(
    summarizeUsageSamples([
      { prompt_tokens: 210, completion_tokens: 20, cached_tokens: 30 },
      { prompt_tokens: 246, completion_tokens: 12, cached_tokens: 0 },
    ]),
  )

  assert.equal(metrics.uncached_prompt_tokens, 426)
  assert.equal(metrics.effective_input_tokens, 426)
  assert.equal(metrics.effective_total_tokens, 458)
  assert.equal(metrics.estimated_cost_usd, undefined)
  assert.equal(metrics.primary_metric, 'effective_total_tokens')
  assert.equal(metrics.primary_metric_value, 458)
  assert.equal(metrics.primary_metric_degraded_reason, null)
})

test('usage tracker records explicit degradation when cached tokens are unavailable', () => {
  const tracker = createUsageTracker()
  tracker.record({ prompt_tokens: 120, completion_tokens: 30, cached_tokens: 20 })
  tracker.record({ prompt_tokens: 80, completion_tokens: 40, cached_tokens: null })

  const metrics = tracker.getDerivedMetrics({
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.25,
  })

  const expectedCost = ((200 * 2.5) + (70 * 10)) / 1_000_000
  assert.equal(metrics.uncached_prompt_tokens, 200)
  assert.equal(metrics.cached_prompt_ratio, 0)
  assert.equal(metrics.effective_input_tokens, 200)
  assert.equal(metrics.effective_total_tokens, 270)
  assert.equal(Number(metrics.estimated_cost_usd!.toFixed(12)), Number(expectedCost.toFixed(12)))
  assert.equal(metrics.primary_metric, 'estimated_cost_usd')
  assert.equal(
    metrics.primary_metric_degraded_reason,
    USAGE_METRIC_DEGRADED_REASON_CACHED_TOKENS_UNAVAILABLE,
  )
})
