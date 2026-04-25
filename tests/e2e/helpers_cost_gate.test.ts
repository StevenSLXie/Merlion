import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  assertNoCostRegression,
  evaluateArchivedCostGate,
  formatCostGateFailure,
  type E2ECostGateReport,
} from './helpers.ts'

test('evaluateArchivedCostGate uses derived totals for the cost-primary metric', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-e2e-cost-gate-'))
  const baselinePath = join(dir, 'cost-baseline.json')
  await writeFile(
    baselinePath,
    JSON.stringify({
      default_threshold_pct: 20,
      default_guardrail_severity: 'warn',
      scenarios: {
        'e2e-read': {
          primary_metric: {
            baselines: {
              effective_total_tokens: 1000,
              estimated_cost_usd: 0.001,
            },
          },
          guardrails: {
            total_tokens: {
              baseline: 1000,
            },
          },
        },
      },
    }),
    'utf8',
  )

  const previousBaselinePath = process.env.MERLION_E2E_COST_BASELINE
  const previousMode = process.env.MERLION_COST_GATE
  process.env.MERLION_E2E_COST_BASELINE = baselinePath
  process.env.MERLION_COST_GATE = 'fail'

  try {
    const report = await evaluateArchivedCostGate(
      'e2e-read',
      900,
      '/tmp/archive.json',
      {
        uncached_prompt_tokens: 700,
        cached_prompt_ratio: 0.25,
        effective_input_tokens: 700,
        effective_total_tokens: 900,
        estimated_cost_usd: 0.0013,
        primary_metric: 'estimated_cost_usd',
        primary_metric_value: 0.0013,
        primary_metric_degraded_reason: null,
      },
    )

    assert.equal(report.decision.status, 'fail')
    assert.equal(report.decision.selectedPrimaryMetric, 'estimated_cost_usd')
    assert.equal(report.decision.observedMetric, 'estimated_cost_usd')
  } finally {
    if (previousBaselinePath === undefined) {
      delete process.env.MERLION_E2E_COST_BASELINE
    } else {
      process.env.MERLION_E2E_COST_BASELINE = previousBaselinePath
    }
    if (previousMode === undefined) {
      delete process.env.MERLION_COST_GATE
    } else {
      process.env.MERLION_COST_GATE = previousMode
    }
  }
})

test('formatCostGateFailure preserves the triggering gate detail and usage archive path', () => {
  const report: E2ECostGateReport = {
    scenario: 'e2e-read',
    totalTokens: 5187,
    archivePath: '/tmp/.merlion/e2e-usage/e2e-read.json',
    decision: {
      status: 'fail',
      selectedPrimaryMetric: 'estimated_cost_usd',
      primaryMetricDegradedReason: 'cached_tokens_unavailable',
      triggeredGate: 'primary',
      observedMetric: 'estimated_cost_usd',
      observedValue: 0.0026,
      thresholdValue: 0.0024,
      thresholdTokens: 4000,
      message:
        '[cost-gate] regression e2e-read: cost-primary metric estimated_cost_usd observed=$0.002600 > ' +
        'threshold=$0.002400 (baseline=$0.002000, threshold_pct=20), degraded_reason=cached_tokens_unavailable',
    },
  }

  assert.equal(
    formatCostGateFailure(report),
    '[cost-gate] regression e2e-read: cost-primary metric estimated_cost_usd observed=$0.002600 > ' +
      'threshold=$0.002400 (baseline=$0.002000, threshold_pct=20), ' +
      'degraded_reason=cached_tokens_unavailable; ' +
      'usage_archive=/tmp/.merlion/e2e-usage/e2e-read.json',
  )
})

test('assertNoCostRegression preserves pass and skip decisions', () => {
  const passReport: E2ECostGateReport = {
    scenario: 'e2e-read',
    totalTokens: 3900,
    archivePath: '/tmp/pass.json',
    decision: {
      status: 'pass',
      thresholdTokens: 4000,
      message: '[cost-gate] pass e2e-read: total=3900, threshold=4000',
    },
  }
  const skipReport: E2ECostGateReport = {
    scenario: 'e2e-read',
    totalTokens: 3900,
    archivePath: '/tmp/skip.json',
    decision: {
      status: 'skip',
      message: '[cost-gate] skipped (mode=off)',
    },
  }

  assert.doesNotThrow(() => assertNoCostRegression(passReport))
  assert.doesNotThrow(() => assertNoCostRegression(skipReport))
})

test('assertNoCostRegression throws only after a deferred failure is inspected', () => {
  const report: E2ECostGateReport = {
    scenario: 'e2e-edit',
    totalTokens: 9471,
    archivePath: '/tmp/fail.json',
    decision: {
      status: 'fail',
      selectedPrimaryMetric: 'effective_total_tokens',
      primaryMetricDegradedReason: null,
      triggeredGate: 'guardrail',
      observedMetric: 'total_tokens',
      observedValue: 9471,
      thresholdValue: 8000,
      thresholdTokens: 8000,
      message:
        '[cost-gate] raw-token guardrail warn e2e-edit: total_tokens observed=9471 > ' +
        'threshold=8000 (baseline=4000, threshold_pct=100, primary_metric=effective_total_tokens)',
    },
  }

  assert.throws(
    () => assertNoCostRegression(report),
    /raw-token guardrail warn e2e-edit: total_tokens observed=9471 > threshold=8000 .* usage_archive=\/tmp\/fail\.json/,
  )
})
