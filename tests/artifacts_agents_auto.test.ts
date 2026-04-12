import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ensureAgentsTemplate,
  renderAgentsAutoSection,
  upsertAgentsAutoSection,
  validateAgentsSections,
} from '../src/artifacts/agents_auto.ts'

test('ensureAgentsTemplate injects MANUAL/AUTO sections', () => {
  const out = ensureAgentsTemplate('# AGENTS\n\nSome intro\n')
  assert.equal(out.includes('<!-- BEGIN MANUAL -->'), true)
  assert.equal(out.includes('<!-- END MANUAL -->'), true)
  assert.equal(out.includes('<!-- BEGIN AUTO -->'), true)
  assert.equal(out.includes('<!-- END AUTO -->'), true)
})

test('upsertAgentsAutoSection replaces only AUTO section', () => {
  const seeded = ensureAgentsTemplate('# AGENTS\n\n')
  const next = upsertAgentsAutoSection(
    seeded,
    renderAgentsAutoSection({
      generatedAt: '2026-04-12T10:00:00.000Z',
      directory: 'src/runtime',
      recentCommits: [
        { hash: 'abc1234', date: '2026-04-12', subject: 'runtime: add path guidance' }
      ],
      recentChangedFiles: ['src/runtime/loop.ts'],
      highChurnFiles: ['src/runtime/loop.ts (changes=7)']
    })
  )

  assert.equal(next.includes('runtime: add path guidance'), true)
  assert.equal(next.includes('2026-04-12T10:00:00.000Z'), true)
  assert.equal(next.includes('src/runtime/loop.ts'), true)
  assert.equal(next.includes('## Purpose'), true)
})

test('validateAgentsSections fails when AUTO markers are missing', () => {
  const out = validateAgentsSections('<!-- BEGIN MANUAL -->\n<!-- END MANUAL -->\n')
  assert.equal(out.ok, false)
  if (!out.ok) {
    assert.match(out.reason, /AUTO/)
  }
})
