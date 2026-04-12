import test from 'node:test'
import assert from 'node:assert/strict'

import { createPermissionStore, type PermissionPromptIo } from '../src/permissions/store.ts'

function createFakeIo(answers: string[]) {
  const writes: string[] = []
  let readCount = 0
  const io: PermissionPromptIo = {
    write(text) {
      writes.push(text)
    },
    async readLine() {
      const answer = answers[readCount] ?? ''
      readCount += 1
      return answer
    }
  }
  return {
    io,
    writes,
    getReadCount: () => readCount
  }
}

test('auto_allow returns allow_session and auto_deny returns deny', async () => {
  const allowStore = createPermissionStore('auto_allow')
  const denyStore = createPermissionStore('auto_deny')
  assert.equal(await allowStore.ask('write_file', 'Write: a.txt'), 'allow_session')
  assert.equal(await denyStore.ask('write_file', 'Write: a.txt'), 'deny')
})

test('interactive mode supports y/n/a and prints tri-state prompt', async () => {
  const fake = createFakeIo(['y', 'n', 'a'])
  const store = createPermissionStore('interactive', fake.io)

  assert.equal(await store.ask('write_file', 'Write: a.txt'), 'allow')
  assert.equal(await store.ask('write_file', 'Write: b.txt'), 'deny')
  assert.equal(await store.ask('write_file', 'Write: c.txt'), 'allow_session')
  assert.equal(fake.getReadCount(), 3)
  const joined = fake.writes.join('')
  assert.match(joined, /1\) yes/)
  assert.match(joined, /2\) no/)
  assert.match(joined, /3\) yes and do not ask again for this tool/i)
})

test('interactive allow_session caches by tool in current session', async () => {
  const fake = createFakeIo(['a', 'y'])
  const store = createPermissionStore('interactive', fake.io)

  assert.equal(await store.ask('todo_write', 'Update todo list: /repo/.merlion/todos.json'), 'allow_session')
  assert.equal(await store.ask('todo_write', 'Append todo: /repo/.merlion/todo.md'), 'allow_session')
  assert.equal(fake.getReadCount(), 1)

  // Different tool still asks again.
  assert.equal(await store.ask('write_file', 'Write: /repo/README.md'), 'allow')
  assert.equal(fake.getReadCount(), 2)
})
