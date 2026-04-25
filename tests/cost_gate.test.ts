import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  evaluateCostGate,
  parseCostGateMode,
  readCostBaseline,
  type CostBaseline,
} from '../src/runtime/cost_gate.ts'
import type { UsageDerivedMetrics } from '../src/runtime/usage.ts'

const baseline: CostBaseline = {
  default_threshold_pct: 20,
  default_guardrail_severity: 'warn',
  scenarios: {
    'e2e-read': {
      primary_metric: {
        baselines: {
          effective_total_tokens: 1000,
          estimated_cost_usd: 0.002,
        },
      },
      guardrails: {
        total_tokens: {
          baseline: 1000,
        },
      },
    },
  },
}

function makeDerivedMetrics(overrides: Partial<UsageDerivedMetrics> = {}): UsageDerivedMetrics {
  return {
    uncached_prompt_tokens: 900,
    cached_prompt_ratio: 0.1,
    effective_input_tokens: 900,
    effective_total_tokens: 1100,
    primary_metric: 'effective_total_tokens',
    primary_metric_value: 1100,
    primary_metric_degraded_reason: null,
    ...overrides,
  }
}

test('parseCostGateMode defaults to fail', () => {
  assert.equal(parseCostGateMode(undefined), 'fail')
  assert.equal(parseCostGateMode('warn'), 'warn')
  assert.equal(parseCostGateMode('off'), 'off')
  assert.equal(parseCostGateMode('unknown'), 'fail')
})

test('evaluateCostGate passes when primary metric is within threshold', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    derivedMetrics: makeDerivedMetrics({
      effective_total_tokens: 1180,
      primary_metric_value: 1180,
    }),
    totalTokens: 1180,
    mode: 'fail',
  })

  assert.equal(decision.status, 'pass')
  assert.equal(decision.selectedPrimaryMetric, 'effective_total_tokens')
  assert.equal(decision.triggeredGate, null)
  assert.match(decision.message, /cost-primary metric effective_total_tokens/)
})

test('evaluateCostGate warns when the selected cost-primary metric regresses in warn mode', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    derivedMetrics: makeDerivedMetrics({
      primary_metric: 'estimated_cost_usd',
      estimated_cost_usd: 0.0026,
      primary_metric_value: 0.0026,
    }),
    totalTokens: 900,
    mode: 'warn',
  })

  assert.equal(decision.status, 'warn')
  assert.equal(decision.selectedPrimaryMetric, 'estimated_cost_usd')
  assert.equal(decision.triggeredGate, 'primary')
  assert.equal(decision.observedMetric, 'estimated_cost_usd')
  assert.match(decision.message, /\$0\.002600/)
})

test('evaluateCostGate fails with degraded detail when the primary metric regresses', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    derivedMetrics: makeDerivedMetrics({
      effective_total_tokens: 1300,
      primary_metric_value: 1300,
      primary_metric_degraded_reason: 'cached_tokens_unavailable',
    }),
    totalTokens: 1300,
    mode: 'fail',
  })

  assert.equal(decision.status, 'fail')
  assert.equal(decision.selectedPrimaryMetric, 'effective_total_tokens')
  assert.equal(decision.triggeredGate, 'primary')
  assert.equal(decision.thresholdTokens, 1200)
  assert.match(decision.message, /degraded_reason=cached_tokens_unavailable/)
})

test('evaluateCostGate warns on raw-token guardrail drift without blocking the primary pass', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    derivedMetrics: makeDerivedMetrics({
      effective_total_tokens: 1000,
      primary_metric_value: 1000,
    }),
    totalTokens: 1300,
    mode: 'fail',
  })

  assert.equal(decision.status, 'warn')
  assert.equal(decision.selectedPrimaryMetric, 'effective_total_tokens')
  assert.equal(decision.triggeredGate, 'guardrail')
  assert.equal(decision.observedMetric, 'total_tokens')
  assert.match(decision.message, /raw-token guardrail warn/)
})

test('evaluateCostGate keeps a compatibility path for effective-total baselines when derived totals are absent', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    totalTokens: 1180,
    mode: 'fail',
  })

  assert.equal(decision.status, 'pass')
  assert.equal(decision.selectedPrimaryMetric, 'effective_total_tokens')
})

test('evaluateCostGate skips when the scenario baseline is missing', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-missing',
    totalTokens: 500,
    mode: 'fail',
  })

  assert.equal(decision.status, 'skip')
})

test('readCostBaseline upgrades the legacy total_tokens schema into the new contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-cost-gate-'))
  const path = join(dir, 'cost-baseline.json')
  await writeFile(path, JSON.stringify({
    default_threshold_pct: 100,
    scenarios: {
      'legacy-read': { total_tokens: 2000 },
    },
  }), 'utf8')

  const parsed = await readCostBaseline(path)

  assert.deepEqual(parsed, {
    default_threshold_pct: 100,
    default_guardrail_severity: 'warn',
    scenarios: {
      'legacy-read': {
        primary_metric: {
          baselines: {
            effective_total_tokens: 2000,
          },
          threshold_pct: undefined,
        },
        guardrails: {
          total_tokens: {
            baseline: 2000,
            threshold_pct: undefined,
            severity: 'warn',
          },
        },
      },
    },
  })
})
