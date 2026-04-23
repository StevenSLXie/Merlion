import test from 'node:test'
import assert from 'node:assert/strict'

import { buildExecutionCharter, renderExecutionCharter } from '../src/runtime/execution_charter.ts'
import { deriveTaskControl } from '../src/runtime/task_state.ts'

test('execution charter renders correction-aware readonly analysis instructions', () => {
  const firstTurn = deriveTaskControl('Analyze this module and summarize its weaknesses.')
  const corrected = deriveTaskControl('I mean the whole project, not just this module.', firstTurn.taskState)
  const charter = buildExecutionCharter(
    corrected.taskState,
    corrected.capabilityProfile,
    corrected.mutationPolicy,
  )
  const rendered = renderExecutionCharter(corrected.taskState, charter)

  assert.equal(charter.toolProfile, 'readonly_analysis')
  assert.equal(charter.mutationPolicy, 'forbidden')
  assert.match(rendered, /Task kind: analysis/)
  assert.match(rendered, /Objective: Re-evaluate the original request across the whole repository/i)
  assert.match(rendered, /Correction note:/)
  assert.match(rendered, /Previous objective replaced:/)
})
