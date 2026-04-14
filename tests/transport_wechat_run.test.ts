import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isWeixinProgressEnabled,
  isWeixinVerboseProgressEnabled,
  renderWeixinReply,
  resolveWeixinPermissionMode,
} from '../src/transport/wechat/run.ts'
import { buildDefaultRegistry } from '../src/tools/builtin/index.ts'
import type { RunLoopResult } from '../src/runtime/loop.ts'
import type { ChatMessage, LoopTerminal } from '../src/types.ts'

function makeLoopResult(params: {
  terminal: LoopTerminal
  finalText?: string
  turnCount?: number
  messages?: ChatMessage[]
}): RunLoopResult {
  return {
    terminal: params.terminal,
    finalText: params.finalText ?? '',
    state: {
      messages: params.messages ?? [],
      turnCount: params.turnCount ?? 1,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      nudgeCount: 0,
    },
  }
}

test('resolveWeixinPermissionMode: interactive defaults to auto_allow with notice', () => {
  const resolved = resolveWeixinPermissionMode('interactive')
  assert.equal(resolved.mode, 'auto_allow')
  assert.match(resolved.notice ?? '', /interactive approval is not supported/i)
})

test('resolveWeixinPermissionMode: undefined defaults to auto_allow with notice', () => {
  const resolved = resolveWeixinPermissionMode(undefined)
  assert.equal(resolved.mode, 'auto_allow')
  assert.match(resolved.notice ?? '', /defaulting to --auto-allow/i)
})

test('resolveWeixinPermissionMode: auto_allow is preserved without notice', () => {
  const resolved = resolveWeixinPermissionMode('auto_allow')
  assert.equal(resolved.mode, 'auto_allow')
  assert.equal(resolved.notice, undefined)
})

test('resolveWeixinPermissionMode: auto_deny is preserved without notice', () => {
  const resolved = resolveWeixinPermissionMode('auto_deny')
  assert.equal(resolved.mode, 'auto_deny')
  assert.equal(resolved.notice, undefined)
})

test('renderWeixinReply returns finalText when available', () => {
  const result = makeLoopResult({
    terminal: 'completed',
    finalText: 'done',
  })
  assert.equal(renderWeixinReply(result), 'done')
})

test('renderWeixinReply falls back to latest assistant text when finalText is empty', () => {
  const result = makeLoopResult({
    terminal: 'max_turns_exceeded',
    finalText: '',
    messages: [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'partial summary' },
    ],
  })
  assert.equal(renderWeixinReply(result), 'partial summary')
})

test('renderWeixinReply maps max_turns_exceeded to user-facing hint', () => {
  const result = makeLoopResult({
    terminal: 'max_turns_exceeded',
    finalText: '',
    turnCount: 30,
    messages: [],
  })
  const reply = renderWeixinReply(result)
  assert.match(reply, /步数预算/)
  assert.match(reply, /30/)
})

test('renderWeixinReply maps model_error to user-facing hint when no text exists', () => {
  const result = makeLoopResult({
    terminal: 'model_error',
    finalText: '',
    messages: [],
  })
  assert.match(renderWeixinReply(result), /模型或网络错误/)
})

test('isWeixinProgressEnabled defaults to false', () => {
  assert.equal(isWeixinProgressEnabled(undefined), false)
  assert.equal(isWeixinProgressEnabled(''), false)
})

test('isWeixinProgressEnabled enables on truthy values', () => {
  assert.equal(isWeixinProgressEnabled('1'), true)
  assert.equal(isWeixinProgressEnabled('true'), true)
  assert.equal(isWeixinProgressEnabled('yes'), true)
})

test('isWeixinProgressEnabled treats 0/false as disabled', () => {
  assert.equal(isWeixinProgressEnabled('0'), false)
  assert.equal(isWeixinProgressEnabled('false'), false)
  assert.equal(isWeixinProgressEnabled('no'), false)
})

test('isWeixinVerboseProgressEnabled defaults to false', () => {
  assert.equal(isWeixinVerboseProgressEnabled(undefined), false)
  assert.equal(isWeixinVerboseProgressEnabled(''), false)
})

test('isWeixinVerboseProgressEnabled enables on truthy values', () => {
  assert.equal(isWeixinVerboseProgressEnabled('1'), true)
  assert.equal(isWeixinVerboseProgressEnabled('true'), true)
  assert.equal(isWeixinVerboseProgressEnabled('yes'), true)
})

test('wechat mode registry excludes config tools from model-visible pool', () => {
  const registry = buildDefaultRegistry({ mode: 'wechat' })
  assert.equal(registry.get('config'), undefined)
  assert.equal(registry.get('config_get'), undefined)
  assert.equal(registry.get('config_set'), undefined)
  assert.equal(registry.get('read_file')?.name, 'read_file')
})
