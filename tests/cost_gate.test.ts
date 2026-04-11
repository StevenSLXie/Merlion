import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCostGate, parseCostGateMode } from '../src/runtime/cost_gate.ts'

const baseline = {
  default_threshold_pct: 20,
  scenarios: {
    'e2e-read': { total_tokens: 1000 },
  },
}

test('parseCostGateMode defaults to fail', () => {
  assert.equal(parseCostGateMode(undefined), 'fail')
  assert.equal(parseCostGateMode('warn'), 'warn')
  assert.equal(parseCostGateMode('off'), 'off')
  assert.equal(parseCostGateMode('unknown'), 'fail')
})

test('evaluateCostGate passes when total tokens within threshold', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    totalTokens: 1180,
    mode: 'fail',
  })
  assert.equal(decision.status, 'pass')
})

test('evaluateCostGate warns when over threshold in warn mode', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    totalTokens: 1300,
    mode: 'warn',
  })
  assert.equal(decision.status, 'warn')
  assert.match(decision.message, /cost-gate/i)
})

test('evaluateCostGate fails when over threshold in fail mode', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-read',
    totalTokens: 1300,
    mode: 'fail',
  })
  assert.equal(decision.status, 'fail')
})

test('evaluateCostGate skips when scenario baseline missing', () => {
  const decision = evaluateCostGate({
    baseline,
    scenario: 'e2e-missing',
    totalTokens: 500,
    mode: 'fail',
  })
  assert.equal(decision.status, 'skip')
})
