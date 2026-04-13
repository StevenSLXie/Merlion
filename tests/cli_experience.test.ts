import test from 'node:test'
import assert from 'node:assert/strict'

import { CliExperience } from '../src/cli/experience.ts'

test('renderAssistantOutput stops leftover spinner timer on error path', () => {
  const ui = new CliExperience({
    model: 'qwen/qwen3-coder',
    sessionId: 'session-test-123456',
    isRepl: false
  })

  const timer = setInterval(() => {}, 1000)
  ;(ui as any).spinnerTimer = timer

  try {
    ui.renderAssistantOutput('Provider authentication failed (401/403).', 'model_error')
    assert.equal((ui as any).spinnerTimer, null)
  } finally {
    clearInterval(timer)
    const maybeTimer = (ui as any).spinnerTimer
    if (maybeTimer) clearInterval(maybeTimer)
  }
})

