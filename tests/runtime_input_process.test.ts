import test from 'node:test'
import assert from 'node:assert/strict'

import { processUserInput } from '../src/runtime/input/process.ts'

test('processUserInput classifies REPL commands and prompt envelopes', () => {
  assert.deepEqual(processUserInput(':q'), { kind: 'local_action', action: 'exit' })
  assert.deepEqual(processUserInput(':help'), { kind: 'local_action', action: 'help' })
  assert.deepEqual(processUserInput(':detail compact'), {
    kind: 'local_action',
    action: 'set_detail',
    payload: 'compact',
  })
  assert.deepEqual(processUserInput('/wechat'), {
    kind: 'slash_command',
    name: 'wechat',
    raw: '/wechat',
  })
  assert.deepEqual(processUserInput(':wechat'), {
    kind: 'slash_command',
    name: 'wechat',
    raw: ':wechat',
  })
  assert.deepEqual(processUserInput(':undo'), {
    kind: 'slash_command',
    name: 'undo',
    raw: ':undo',
  })
  assert.deepEqual(processUserInput('! echo ok'), {
    kind: 'shell_shortcut',
    command: 'echo ok',
  })
  assert.deepEqual(processUserInput('fix auth flow'), {
    kind: 'prompt',
    text: 'fix auth flow',
  })
  assert.deepEqual(processUserInput('   '), { kind: 'empty' })
})
