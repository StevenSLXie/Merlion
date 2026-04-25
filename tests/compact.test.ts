import assert from 'node:assert/strict'
import test from 'node:test'

import { compactItems, estimateItemsChars } from '../src/context/compact.ts'
import {
  createAssistantItem,
  createExternalUserItem,
  createFunctionCallOutputItem,
  createRuntimeUserItem,
  createSystemItem,
} from '../src/runtime/items.ts'

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

test('compactItems preserves the latest function_call to function_call_output trace while summarizing older gaps', () => {
  const items = [
    createExternalUserItem('previous task'),
    createAssistantItem('older investigation details'),
    createExternalUserItem('current task'),
    createAssistantItem('pre-tool commentary that can be compacted'),
    {
      kind: 'function_call' as const,
      callId: 'call_1',
      name: 'read_file',
      argumentsText: '{"path":"src/runtime/loop.ts"}',
    },
    createFunctionCallOutputItem('call_1', 'loop contents'),
    createAssistantItem('latest explanation'),
  ]

  const compacted = compactItems(items, { keepRecent: 2 })
  assert.equal(compacted.compacted, true)

  const summaryItems = compacted.items.filter((item) =>
    item.kind === 'message' &&
    item.role === 'system' &&
    item.source === 'runtime' &&
    item.content.includes('Conversation compact summary')
  )
  assert.equal(summaryItems.length, 2)
  assert.equal(summaryItems.some((item) => item.content.includes('previous task')), true)
  assert.equal(summaryItems.some((item) => item.content.includes('pre-tool commentary that can be compacted')), true)

  const preservedCurrentTask = compacted.items.find((item) =>
    item.kind === 'message' &&
    item.role === 'user' &&
    item.source === 'external' &&
    item.content === 'current task'
  )
  assert.ok(preservedCurrentTask)
  assert.equal(
    compacted.items.some((item) => item.kind === 'message' && item.role === 'assistant' && item.content === 'pre-tool commentary that can be compacted'),
    false,
  )

  const functionCallIndex = compacted.items.findIndex((item) => item.kind === 'function_call' && item.callId === 'call_1')
  const outputIndex = compacted.items.findIndex((item) => item.kind === 'function_call_output' && item.callId === 'call_1')
  assert.equal(functionCallIndex >= 0, true)
  assert.equal(outputIndex > functionCallIndex, true)
})
