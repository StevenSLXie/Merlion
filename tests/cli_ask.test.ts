import test from 'node:test'
import assert from 'node:assert/strict'

import { askLineWithFactory, type AskLineFactory } from '../src/cli/ask.ts'

test('askLineWithFactory closes interface after successful read', async () => {
  let closeCalls = 0
  const factory: AskLineFactory = () => ({
    async question(question: string) {
      assert.equal(question, 'hello? ')
      return 'yes'
    },
    close() {
      closeCalls += 1
    }
  })

  const result = await askLineWithFactory('hello? ', factory)
  assert.equal(result, 'yes')
  assert.equal(closeCalls, 1)
})

test('askLineWithFactory closes interface when read throws', async () => {
  let closeCalls = 0
  const factory: AskLineFactory = () => ({
    async question() {
      throw new Error('eof')
    },
    close() {
      closeCalls += 1
    }
  })

  const result = await askLineWithFactory('ignored', factory)
  assert.equal(result, null)
  assert.equal(closeCalls, 1)
})
