import test from 'node:test'
import assert from 'node:assert/strict'

import { getSystemSlashCommands } from '../src/cli/commands.ts'
import { resolveSubmittedReplInput } from '../src/cli/input_buffer.ts'

test('resolveSubmittedReplInput keeps bare slash when multiple slash commands exist', () => {
  assert.equal(resolveSubmittedReplInput('/', getSystemSlashCommands()), '/')
})

test('resolveSubmittedReplInput resolves unique slash prefix on submit', () => {
  assert.equal(resolveSubmittedReplInput('/we', getSystemSlashCommands()), '/wechat')
  assert.equal(resolveSubmittedReplInput('/un', getSystemSlashCommands()), '/undo')
  assert.equal(resolveSubmittedReplInput('/wechat', getSystemSlashCommands()), '/wechat')
})

test('resolveSubmittedReplInput keeps non-slash and slash-with-args input unchanged', () => {
  assert.equal(resolveSubmittedReplInput('fix auth bug', getSystemSlashCommands()), 'fix auth bug')
  assert.equal(resolveSubmittedReplInput('/wechat login', getSystemSlashCommands()), '/wechat login')
})
