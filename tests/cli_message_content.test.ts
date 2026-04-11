import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAssistantRenderPlan } from '../src/cli/message_content.ts'

test('buildAssistantRenderPlan falls back to plain text when markdown disabled', () => {
  const plan = buildAssistantRenderPlan('# Title\n- a', { markdownEnabled: false })
  assert.equal(plan.mode, 'plain')
  assert.deepEqual(plan.lines.map((l) => l.tone), ['plain', 'plain'])
})

test('buildAssistantRenderPlan uses markdown tones when enabled and markdown detected', () => {
  const plan = buildAssistantRenderPlan('# Title\n- a', { markdownEnabled: true })
  assert.equal(plan.mode, 'markdown')
  assert.deepEqual(plan.lines.map((l) => l.tone), ['heading', 'list'])
})

test('buildAssistantRenderPlan handles plain multi-line text', () => {
  const plan = buildAssistantRenderPlan('line1\nline2')
  assert.equal(plan.mode, 'plain')
  assert.equal(plan.lines[0]?.text, 'line1')
  assert.equal(plan.lines[1]?.text, 'line2')
})
