import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTuiKeyAction } from '../src/cli/keybindings.ts'

test('parseTuiKeyAction maps expected keys', () => {
  assert.equal(parseTuiKeyAction('f'), 'set_full')
  assert.equal(parseTuiKeyAction('F'), 'set_full')
  assert.equal(parseTuiKeyAction('c'), 'set_compact')
  assert.equal(parseTuiKeyAction('?'), 'help')
  assert.equal(parseTuiKeyAction(Buffer.from([3])), 'interrupt')
  assert.equal(parseTuiKeyAction('x'), null)
})
