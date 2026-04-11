import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../src/types.ts'
import { compactMessages, estimateMessagesChars } from '../src/context/compact.ts'

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
