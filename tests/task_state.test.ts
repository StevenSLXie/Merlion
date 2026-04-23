import test from 'node:test'
import assert from 'node:assert/strict'

import {
  commandLooksDestructiveForReadonly,
  deriveTaskControl,
  profileAllowsSubagentRole,
  scriptAllowedForReadonlyVerification,
} from '../src/runtime/task_state.ts'

test('deriveTaskControl classifies representative prompts into stable task kinds', () => {
  assert.equal(deriveTaskControl('What does this project do?').taskState.kind, 'question')
  assert.equal(deriveTaskControl('Analyze this repository and tell me its weaknesses.').taskState.kind, 'analysis')
  assert.equal(deriveTaskControl('Review the current working tree and give findings.').taskState.kind, 'review')
  assert.equal(deriveTaskControl('Verify the fix by running the relevant tests.').taskState.kind, 'verification')
  assert.equal(deriveTaskControl('Fix the failing login flow in src/auth.ts.').taskState.kind, 'implementation')
})

test('deriveTaskControl rewrites correction prompts against the previous objective', () => {
  const firstTurn = deriveTaskControl('Analyze this module and tell me its weaknesses.')
  const corrected = deriveTaskControl('I mean the whole project, not just this module.', firstTurn.taskState)

  assert.equal(corrected.taskState.kind, 'analysis')
  assert.equal(corrected.taskState.correctionOfPreviousTurn, true)
  assert.equal(corrected.taskState.replacesPreviousObjective, true)
  assert.equal(corrected.taskState.inheritedObjective, firstTurn.taskState.activeObjective)
  assert.match(corrected.taskState.activeObjective, /whole repository/i)
  assert.equal(corrected.taskState.requiredEvidence, 'codebacked')
})

test('readonly and implementation profiles derive the expected mutation policy', () => {
  const readonly = deriveTaskControl('Review the latest diff.')
  assert.equal(readonly.capabilityProfile, 'readonly_review')
  assert.equal(readonly.mutationPolicy.mayMutateFiles, false)
  assert.equal(readonly.mutationPolicy.mayRunDestructiveShell, false)

  const implementation = deriveTaskControl('Implement the requested CLI flag in src/index.ts.')
  assert.equal(implementation.capabilityProfile, 'implementation_scoped')
  assert.equal(implementation.mutationPolicy.mayMutateFiles, true)
  assert.equal(implementation.mutationPolicy.mayRunDestructiveShell, true)
  assert.deepEqual(implementation.mutationPolicy.writableScopes, ['src/index.ts'])
})

test('readonly shell and verification-script heuristics are conservative', () => {
  assert.equal(commandLooksDestructiveForReadonly('touch notes.txt'), true)
  assert.equal(commandLooksDestructiveForReadonly('npm test -- --runInBand'), false)
  assert.equal(scriptAllowedForReadonlyVerification('test:unit'), true)
  assert.equal(scriptAllowedForReadonlyVerification('build'), false)
})

test('only implementation profiles may spawn worker subagents', () => {
  assert.equal(profileAllowsSubagentRole('readonly_analysis', 'worker'), false)
  assert.equal(profileAllowsSubagentRole('readonly_analysis', 'explorer'), true)
  assert.equal(profileAllowsSubagentRole('verification_readonly', 'verifier'), true)
  assert.equal(profileAllowsSubagentRole('implementation_scoped', 'worker'), true)
})
