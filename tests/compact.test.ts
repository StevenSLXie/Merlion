import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../src/types.ts'
import { compactItems, compactMessages, estimateItemsChars, estimateMessagesChars } from '../src/context/compact.ts'
import { createAssistantItem, createExternalUserItem, createRuntimeUserItem, createSystemItem } from '../src/runtime/items.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

test('estimateMessagesChars returns positive size for non-empty messages', () => {
  const value = estimateMessagesChars([msg('user', 'hello'), msg('assistant', 'world')])
  assert.equal(value > 0, true)
})

test('compactMessages preserves system + recent messages', () => {
  const messages: ChatMessage[] = [
    msg('system', 'system instructions'),
    ...Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `message-${i}`)),
  ]

  const compacted = compactMessages(messages, { keepRecent: 6 })
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.messages[0]?.role, 'system')
  const summary = compacted.messages.find((m) =>
    typeof m.content === 'string' && m.content.includes('Conversation compact summary')
  )
  assert.ok(summary)
  assert.equal(compacted.messages.length <= 8, true)
})

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
