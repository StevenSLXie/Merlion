import assert from 'node:assert/strict'
import test from 'node:test'

import { compactItems, estimateItemsChars } from '../src/context/compact.ts'
import { createAssistantItem, createExternalUserItem, createRuntimeUserItem, createSystemItem } from '../src/runtime/items.ts'

test('compactItems anchors on last external user instead of later runtime-injected user hints', () => {
  const items = [
    createSystemItem('base system', 'static'),
    createExternalUserItem('older task'),
    createAssistantItem('older answer'),
    createExternalUserItem('initial task'),
    createAssistantItem('I will inspect the file.'),
    createRuntimeUserItem('Please verify the change before finishing.'),
    createAssistantItem('working on it'),
  ]

  const compacted = compactItems(items, { keepRecent: 2 })
  assert.equal(compacted.compacted, true)
  const summary = compacted.items.find((item) => {
    if (item.kind !== 'message') return false
    return (
      item.role === 'system' &&
      item.source === 'runtime' &&
      item.content.includes('Conversation compact summary')
    )
  })
  assert.ok(summary)
  const remainingExternal = compacted.items.filter((item): item is ReturnType<typeof createExternalUserItem> =>
    item.kind === 'message' && item.role === 'user' && item.source === 'external'
  )
  assert.equal(remainingExternal.length, 1)
  assert.equal(remainingExternal[0]?.content, 'initial task')
})

test('estimateItemsChars returns positive size for non-empty items', () => {
  const size = estimateItemsChars([
    createSystemItem('system', 'static'),
    createExternalUserItem('task'),
  ])
  assert.equal(size > 0, true)
})
