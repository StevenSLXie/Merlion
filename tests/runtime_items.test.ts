import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../src/types.ts'
import {
  buildCanonicalRequestAssembly,
  createAssistantItem,
  createExternalUserItem,
  createFunctionCallOutputItem,
  createRuntimeUserItem,
  createSystemItem,
  itemsToMessages,
  legacyMessageToItems,
  messagesToItems,
  pruneNonPersistentRuntimeItems,
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

test('canonical request builder sorts and deduplicates overlay items across categories', () => {
  const stablePrefixItems = [createSystemItem('system prompt', 'static')]
  const transcriptItems = [createExternalUserItem('Inspect src/runtime/items.ts')]
  const promptPreludeItems = [
    createSystemItem('Prompt-derived path guidance.\n\nfocus: src/runtime/items.ts', 'runtime'),
    createSystemItem('User-specified target paths detected.\n- src/runtime/items.ts', 'runtime'),
  ]
  const runtimeOverlayItems = [
    createRuntimeUserItem('Continue with the task. Use your tools to make progress. If you have completed everything, describe what was done.'),
    createSystemItem('Path guidance update.\n\n- src/runtime/query_engine.ts', 'runtime'),
    createRuntimeUserItem('Before concluding a code-change task, provide validation evidence. Run the most relevant available check now, or explicitly state what you could not validate and why. Do not claim success without naming the command, repro, or test coverage you relied on.'),
    createSystemItem('Path guidance update.\n\n- src/runtime/query_engine.ts', 'runtime'),
    createRuntimeUserItem('No progress detected: the last 3 tool batches all failed. Stop retrying broad mutations. Re-plan with 2-3 concrete steps, validate target paths via `list_dir`/`stat_path`, then run one minimal next tool call.'),
  ]

  const first = buildCanonicalRequestAssembly({
    stablePrefixItems,
    promptPreludeItems,
    executionCharterText: 'Execution charter for this turn:\n- stay focused',
    runtimeOverlayItems,
    transcriptItems,
    intentContract: 'Mention only concrete outcomes.',
  })
  const second = buildCanonicalRequestAssembly({
    stablePrefixItems,
    promptPreludeItems: [...promptPreludeItems].reverse(),
    executionCharterText: 'Execution charter for this turn:\n- stay focused',
    runtimeOverlayItems: [...runtimeOverlayItems].reverse(),
    transcriptItems,
    intentContract: 'Mention only concrete outcomes.',
  })

  assert.deepEqual(second.overlayItems, first.overlayItems)
  assert.deepEqual(
    first.overlayItems.map((item) => item.kind === 'message' ? `${item.role}:${item.content}` : item.kind),
    [
      'system:User-specified target paths detected.\n- src/runtime/items.ts',
      'system:Prompt-derived path guidance.\n\nfocus: src/runtime/items.ts',
      'system:Execution charter for this turn:\n- stay focused',
      'system:Path guidance update.\n\n- src/runtime/query_engine.ts',
      'user:No progress detected: the last 3 tool batches all failed. Stop retrying broad mutations. Re-plan with 2-3 concrete steps, validate target paths via `list_dir`/`stat_path`, then run one minimal next tool call.',
      'user:Before concluding a code-change task, provide validation evidence. Run the most relevant available check now, or explicitly state what you could not validate and why. Do not claim success without naming the command, repro, or test coverage you relied on.',
      'user:Continue with the task. Use your tools to make progress. If you have completed everything, describe what was done.',
      'system:Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\nMention only concrete outcomes.',
    ],
  )
  assert.deepEqual(first.requestItems, [...stablePrefixItems, ...first.overlayItems, ...transcriptItems])
})

test('pruneNonPersistentRuntimeItems removes canonical overlay templates but keeps persistent transcript items', () => {
  const items = [
    createSystemItem('system prompt', 'static'),
    createSystemItem('User-specified target paths detected.\n- src/runtime/items.ts', 'runtime'),
    createSystemItem('Prompt-derived path guidance.\n\nfocus: src/runtime/items.ts', 'runtime'),
    createSystemItem('Path guidance update.\n\n- src/runtime/query_engine.ts', 'runtime'),
    createSystemItem('Execution charter for this turn:\n- stay focused', 'runtime'),
    createSystemItem(
      'Execution contract for the current request. Treat these constraints as mandatory unless the user explicitly changes them.\n\nMention only concrete outcomes.',
      'runtime',
    ),
    createRuntimeUserItem('Before concluding a code-change task, provide validation evidence. Run the most relevant available check now, or explicitly state what you could not validate and why. Do not claim success without naming the command, repro, or test coverage you relied on.'),
    createRuntimeUserItem('No progress detected: the last 3 tool batches all failed. Stop retrying broad mutations. Re-plan with 2-3 concrete steps, validate target paths via `list_dir`/`stat_path`, then run one minimal next tool call.'),
    createExternalUserItem('real user prompt'),
  ]

  assert.deepEqual(pruneNonPersistentRuntimeItems(items), [
    createSystemItem('system prompt', 'static'),
    createExternalUserItem('real user prompt'),
  ])
})

test('pruneNonPersistentRuntimeItems also strips legacy runtime user overlays from older transcripts', () => {
  const items = [
    createSystemItem('system prompt', 'static'),
    createRuntimeUserItem('Please verify the change before finishing.'),
    createRuntimeUserItem('You only changed tests so far.'),
    createExternalUserItem('real user prompt'),
  ]

  assert.deepEqual(pruneNonPersistentRuntimeItems(items), [
    createSystemItem('system prompt', 'static'),
    createExternalUserItem('real user prompt'),
  ])
})
