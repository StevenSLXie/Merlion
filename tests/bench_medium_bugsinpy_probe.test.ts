import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEphemeralCaseSpec } from '../scripts/bench_medium/bugsinpy/probe.ts'

test('buildEphemeralCaseSpec builds fixed probe spec', () => {
  const spec = buildEphemeralCaseSpec({ project: 'thefuck', bugId: 7, version: 'fixed' })
  assert.equal(spec.id, 'PROBE_THEFUCK_7_FIXED')
  assert.equal(spec.version, 'fixed')
  assert.match(spec.taskPrompt, /Do not modify code/)
})
