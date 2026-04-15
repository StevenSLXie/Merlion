import test from 'node:test'
import assert from 'node:assert/strict'

import { getSystemSlashCommands } from '../src/cli/commands.ts'
import { formatInlineCompletionPreview, getSlashSuggestions } from '../src/cli/completion.ts'

test('getSlashSuggestions matches prefix from slash registry', () => {
  const suggestions = getSlashSuggestions('/we', getSystemSlashCommands())
  assert.deepEqual(suggestions, [
    { name: '/wechat', description: 'Start WeChat login + listen mode.' }
  ])
})

test('getSlashSuggestions returns empty for non-slash input', () => {
  assert.deepEqual(getSlashSuggestions('wechat', getSystemSlashCommands()), [])
})

test('formatInlineCompletionPreview renders compact inline suggestion list', () => {
  const preview = formatInlineCompletionPreview([
    { name: '/wechat', description: 'Start WeChat login + listen mode.' }
  ])
  assert.equal(preview, ' [slash: /wechat]')
})
