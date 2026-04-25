import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { evaluateCostGate, readCostBaseline } from '../../src/runtime/cost_gate.ts'
import {
  assertArchivedCostGateContract,
  assertNoCostRegression,
  buildUsageArchivePayload,
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

test('docs/cost-baseline.json keeps targeted rollout scenarios on effective_total_tokens without rate-backed totals', async () => {
  const baseline = await readCostBaseline(join(process.cwd(), 'docs', 'cost-baseline.json'))
  assert.ok(baseline, 'expected docs/cost-baseline.json to load')

  for (const [scenario, totalTokens] of [
    ['e2e-read', 1800],
    ['e2e-search', 1800],
    ['e2e-tool-error', 1800],
    ['e2e-multi-tool', 2700],
    ['e2e-edit', 3600],
  ] as const) {
    const decision = evaluateCostGate({
      baseline,
      scenario,
      totalTokens,
      derivedMetrics: {
        uncached_prompt_tokens: totalTokens - 200,
        cached_prompt_ratio: 0,
        effective_input_tokens: totalTokens - 200,
        effective_total_tokens: totalTokens,
        primary_metric: 'effective_total_tokens',
        primary_metric_value: totalTokens,
        primary_metric_degraded_reason: null,
      },
      mode: 'fail',
    })

    assert.notEqual(decision.status, 'skip', `${scenario} should keep a live baseline`)
    if (decision.status === 'skip') continue
    assert.equal(decision.selectedPrimaryMetric, 'effective_total_tokens')
  }
})

test('docs/cost-baseline.json lets targeted rollout scenarios switch to estimated_cost_usd when rates are configured', async () => {
  const baseline = await readCostBaseline(join(process.cwd(), 'docs', 'cost-baseline.json'))
  assert.ok(baseline, 'expected docs/cost-baseline.json to load')

  for (const [scenario, observedUsd] of [
    ['e2e-read', 0.0018],
    ['e2e-search', 0.0018],
    ['e2e-tool-error', 0.0018],
    ['e2e-multi-tool', 0.0027],
    ['e2e-edit', 0.0036],
  ] as const) {
    const decision = evaluateCostGate({
      baseline,
      scenario,
      totalTokens: Math.round(observedUsd * 1_000_000),
      derivedMetrics: {
        uncached_prompt_tokens: Math.round(observedUsd * 1_000_000) - 200,
        cached_prompt_ratio: 0.2,
        effective_input_tokens: Math.round(observedUsd * 1_000_000) - 200,
        effective_total_tokens: Math.round(observedUsd * 1_000_000),
        estimated_cost_usd: observedUsd,
        primary_metric: 'estimated_cost_usd',
        primary_metric_value: observedUsd,
        primary_metric_degraded_reason: null,
      },
      mode: 'fail',
    })

    assert.notEqual(decision.status, 'skip', `${scenario} should keep a live baseline`)
    if (decision.status === 'skip') continue
    assert.equal(decision.selectedPrimaryMetric, 'estimated_cost_usd')
  }
})

test('assertArchivedCostGateContract validates fallback and USD-primary archive alignment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-e2e-archive-contract-'))
  const fallbackArchivePath = join(dir, 'fallback.json')
  const usdArchivePath = join(dir, 'usd.json')

  await writeFile(
    fallbackArchivePath,
    `${JSON.stringify(buildUsageArchivePayload({
      scenario: 'e2e-read',
      task: 'Read hello.txt',
      cwd: '/tmp/merlion-test',
      result: {
        terminal: 'completed',
        finalText: 'done',
        state: {
          items: [],
          turnCount: 1,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          nudgeCount: 0,
        },
      },
      model: 'test-model',
      baseURL: 'https://example.test/v1',
      usageSamples: [{ prompt_tokens: 900, completion_tokens: 100, cached_tokens: 0 }],
      totals: {
        prompt_tokens: 900,
        completion_tokens: 100,
        cached_tokens: 0,
        total_tokens: 1000,
      },
      toolSchema: {
        tool_count: 1,
        tool_schema_serialized_chars: 128,
        tool_schema_tokens_estimate: 32,
        tool_schema_serialized: '[]',
      },
      promptObservability: [{
        turn: 1,
        estimated_input_tokens: 1000,
        tool_schema_tokens_estimate: 32,
        role_tokens: { system: 100, user: 50, assistant: 0, tool: 0 },
        role_delta_tokens: { system: 100, user: 50, assistant: 0, tool: 0 },
        stable_prefix_tokens: 0,
        stable_prefix_ratio: 0,
        stable_prefix_hash: null,
      }],
    }), null, 2)}\n`,
    'utf8',
  )

  await writeFile(
    usdArchivePath,
    `${JSON.stringify(buildUsageArchivePayload({
      scenario: 'e2e-read',
      task: 'Read hello.txt',
      cwd: '/tmp/merlion-test',
      result: {
        terminal: 'completed',
        finalText: 'done',
        state: {
          items: [],
          turnCount: 1,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          nudgeCount: 0,
        },
      },
      model: 'test-model',
      baseURL: 'https://example.test/v1',
      usageSamples: [{ prompt_tokens: 900, completion_tokens: 100, cached_tokens: 0 }],
      totals: {
        prompt_tokens: 900,
        completion_tokens: 100,
        cached_tokens: 0,
        total_tokens: 1000,
      },
      toolSchema: {
        tool_count: 1,
        tool_schema_serialized_chars: 128,
        tool_schema_tokens_estimate: 32,
        tool_schema_serialized: '[]',
      },
      promptObservability: [{
        turn: 1,
        estimated_input_tokens: 1000,
        tool_schema_tokens_estimate: 32,
        role_tokens: { system: 100, user: 50, assistant: 0, tool: 0 },
        role_delta_tokens: { system: 100, user: 50, assistant: 0, tool: 0 },
        stable_prefix_tokens: 0,
        stable_prefix_ratio: 0,
        stable_prefix_hash: null,
      }],
      usageRates: {
        inputPerMillion: 1,
        outputPerMillion: 1,
        cachedInputPerMillion: 0,
      },
    }), null, 2)}\n`,
    'utf8',
  )

  await assert.doesNotReject(() =>
    assertArchivedCostGateContract(
      {
        scenario: 'e2e-read',
        totalTokens: 1000,
        archivePath: fallbackArchivePath,
        decision: {
          status: 'pass',
          selectedPrimaryMetric: 'effective_total_tokens',
          primaryMetricDegradedReason: null,
          triggeredGate: null,
          observedMetric: 'effective_total_tokens',
          observedValue: 1000,
          thresholdValue: 2000,
          thresholdTokens: 2000,
          message: '[cost-gate] pass e2e-read: cost-primary metric effective_total_tokens observed=1000 <= threshold=2000 (baseline=1000, threshold_pct=100)',
        },
      },
      'e2e-read',
      { env: {} },
    )
  )

  await assert.doesNotReject(() =>
    assertArchivedCostGateContract(
      {
        scenario: 'e2e-read',
        totalTokens: 1000,
        archivePath: usdArchivePath,
        decision: {
          status: 'pass',
          selectedPrimaryMetric: 'estimated_cost_usd',
          primaryMetricDegradedReason: null,
          triggeredGate: null,
          observedMetric: 'estimated_cost_usd',
          observedValue: 0.001,
          thresholdValue: 0.002,
          message: '[cost-gate] pass e2e-read: cost-primary metric estimated_cost_usd observed=$0.001000 <= threshold=$0.002000 (baseline=$0.001000, threshold_pct=100)',
        },
      },
      'e2e-read',
      {
        env: {
          MERLION_COST_INPUT_PER_1M: '1',
          MERLION_COST_OUTPUT_PER_1M: '1',
          MERLION_COST_CACHED_INPUT_PER_1M: '0',
        },
      },
    )
  )
})
