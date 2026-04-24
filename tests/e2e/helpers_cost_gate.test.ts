import assert from 'node:assert/strict'
import test from 'node:test'

import { assertNoCostRegression, formatCostGateFailure, type E2ECostGateReport } from './helpers.ts'

test('formatCostGateFailure includes threshold comparison and usage archive path', () => {
  const report: E2ECostGateReport = {
    scenario: 'e2e-read',
    totalTokens: 5187,
    archivePath: '/tmp/.merlion/e2e-usage/e2e-read.json',
    decision: {
      status: 'fail',
      thresholdTokens: 4000,
      message: '[cost-gate] regression e2e-read: total=5187 > threshold=4000 (baseline=2000, threshold_pct=100)',
    },
  }

  assert.equal(
    formatCostGateFailure(report),
    '[cost-gate] regression e2e-read after behavior checks: total=5187 > threshold=4000; ' +
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
      thresholdTokens: 8000,
      message: '[cost-gate] regression e2e-edit: total=9471 > threshold=8000 (baseline=4000, threshold_pct=100)',
    },
  }

  assert.throws(
    () => assertNoCostRegression(report),
    /after behavior checks: total=9471 > threshold=8000; usage_archive=\/tmp\/fail\.json/,
  )
})
