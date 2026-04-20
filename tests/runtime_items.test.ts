import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../src/types.ts'
import {
  createAssistantItem,
  createExternalUserItem,
  createFunctionCallOutputItem,
  createRuntimeUserItem,
  createSystemItem,
  itemsToMessages,
  legacyMessageToItems,
  messagesToItems,
} from '../src/runtime/items.ts'

test('legacy assistant message with content and tool calls canonicalizes to message then function calls', () => {
  const message: ChatMessage = {
    role: 'assistant',
    content: 'Let me inspect that.',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' }
      }
    ]
  }

  const items = legacyMessageToItems(message)
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((item) => item.kind === 'message' ? `${item.role}:${item.source}` : item.kind),
    ['assistant:provider', 'function_call']
  )
})

test('legacy runtime injected user prompt is classified as runtime', () => {
  const items = legacyMessageToItems({
    role: 'user',
    content: 'Output was cut off. Continue directly from where you stopped. No recap, no apology.',
  })
  assert.equal(items.length, 1)
  assert.equal(items[0]?.kind, 'message')
  assert.equal(items[0]?.role, 'user')
  assert.equal(items[0]?.source, 'runtime')
})

test('legacy unknown user prompt defaults to external', () => {
  const items = legacyMessageToItems({
    role: 'user',
    content: 'Please update the login flow and run the tests afterwards.',
  })
  assert.equal(items[0]?.kind, 'message')
  assert.equal(items[0]?.role, 'user')
  assert.equal(items[0]?.source, 'external')
})

test('itemsToMessages folds assistant message plus following function call items into one assistant message', () => {
  const messages = itemsToMessages([
    createSystemItem('system', 'static'),
    createExternalUserItem('test'),
    createAssistantItem('I will inspect the file first.'),
    {
      kind: 'function_call',
      callId: 'call_1',
      itemId: 'fc_1',
      name: 'read_file',
      argumentsText: '{"path":"src/app.ts"}',
    },
    createFunctionCallOutputItem('call_1', 'file content'),
    createRuntimeUserItem('Please verify the change before finishing.'),
  ])

  assert.equal(messages.length, 5)
  assert.equal(messages[2]?.role, 'assistant')
  assert.equal(messages[2]?.tool_calls?.length, 1)
  assert.equal(messages[3]?.role, 'tool')
  assert.equal(messages[4]?.role, 'user')
})

test('messagesToItems marks first system message static and later system messages runtime', () => {
  const items = messagesToItems([
    { role: 'system', content: 'base system' },
    { role: 'system', content: 'path guidance update' },
  ])

  assert.equal(items.length, 2)
  assert.equal(items[0]?.kind, 'message')
  assert.equal(items[0]?.role, 'system')
  assert.equal(items[0]?.source, 'static')
  assert.equal(items[1]?.kind, 'message')
  assert.equal(items[1]?.role, 'system')
  assert.equal(items[1]?.source, 'runtime')
})

