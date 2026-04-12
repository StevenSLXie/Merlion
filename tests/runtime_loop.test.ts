import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { runLoop, shouldNudge } from '../src/runtime/loop.ts'

class StubProvider implements ModelProvider {
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected provider call at index=${this.index}`)
    this.index += 1
    return response
  }
}

class ThrowProvider implements ModelProvider {
  private readonly error: Error
  constructor(message: string) {
    this.error = new Error(message)
  }
  async complete(): Promise<AssistantResponse> {
    throw this.error
  }
}

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

function makeEchoTool(): ToolDefinition {
  return {
    name: 'echo_tool',
    description: 'echoes input',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    concurrencySafe: true,
    async execute(input) {
      return { content: `echo:${String(input.value)}`, isError: false }
    }
  }
}

function makeAlwaysFailTool(): ToolDefinition {
  return {
    name: 'always_fail',
    description: 'always fails',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    concurrencySafe: true,
    async execute(input) {
      return { content: `File not found: ${String(input.path)}`, isError: true }
    }
  }
}

test('loop executes tool call then completes', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  assert.equal(result.state.messages.some((m) => m.role === 'tool'), true)
})

test('loop handles unknown tool safely', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('not_exists', {})],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'finished',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'finished')
  const toolMsg = result.state.messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg)
  assert.match(toolMsg?.content ?? '', /Unknown tool/)
})

test('loop returns terminal assistant text', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'all good',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'all good')
})

test('loop recovers empty stop after tool calls by requesting final summary', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'Edited tests/executor.test.ts by adding one blank line.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8
  })

  assert.equal(result.terminal, 'completed')
  assert.match(result.finalText, /Edited tests\/executor\.test\.ts/)
  assert.equal(
    result.state.messages.some((m) => m.role === 'user' && (m.content ?? '').includes('Provide a concise final summary')),
    true
  )
})

test('loop falls back to synthetic summary when stop remains empty after recovery', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8
  })

  assert.equal(result.terminal, 'completed')
  assert.match(result.finalText, /returned no final summary/i)
})

test('loop accepts initial messages', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'continued',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'ignored because initial messages provided',
    userPrompt: '',
    cwd: process.cwd(),
    maxTurns: 5,
    initialMessages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' }
    ],
    persistInitialMessages: false
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'continued')
  assert.equal(result.state.messages.length >= 4, true)
})

// ── shouldNudge unit tests ─────────────────────────────────────────────────

test('shouldNudge: never nudges short conversational text', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(shouldNudge('在', baseState), false)
  assert.equal(shouldNudge('yes', baseState), false)
  assert.equal(shouldNudge('done', baseState), false)
  assert.equal(shouldNudge('ok', baseState), false)
  assert.equal(shouldNudge('', baseState), false)
})

test('shouldNudge: detects false start with I will/I\'ll pattern', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  const longEnough = "I'll start by reading the auth file and understanding the current session management approach."
  assert.equal(shouldNudge(longEnough, baseState), true)
})

test('shouldNudge: detects "let me" false start', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('Let me read the configuration file to understand the current setup.', baseState),
    true,
  )
})

test('shouldNudge: does not nudge genuine past-tense completion', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('The function has been updated successfully. The type error on line 42 is fixed.', baseState),
    false,
  )
})

test('shouldNudge: cap at 2 nudges prevents infinite nudge loop', () => {
  const cappedState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 2
  }
  const text = "Let me read the configuration file to understand the current setup."
  assert.equal(shouldNudge(text, cappedState), false)
})

test('loop injects nudge then completes when model stops after nudge', async () => {
  const LONG_WILL_DO = "I'll start by reading the authentication module to understand the existing session management approach."

  const provider = new StubProvider([
    {
      role: 'assistant',
      content: LONG_WILL_DO,
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Task is now complete.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'fix the auth bug',
    cwd: process.cwd(),
    maxTurns: 10,
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'Task is now complete.')
  assert.equal(result.state.nudgeCount, 1)
  // Nudge message must be present in state
  const nudgeMsg = result.state.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Continue with the task'),
  )
  assert.ok(nudgeMsg, 'nudge message should be in state.messages')
})

test('loop returns model_error for content_filter finish_reason', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'content_filter',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'model_error')
})

test('loop returns auth-specific remediation when provider key is invalid', async () => {
  const provider = new ThrowProvider('Provider error 401: Invalid API key')
  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'model_error')
  assert.match(result.finalText, /authentication failed/i)
  assert.match(result.finalText, /merlion config/)
  assert.match(result.finalText, /~\/\.config\/merlion\/config\.json/)
  assert.match(result.finalText, /MERLION_API_KEY/)
})

test('loop handles tool_calls finish_reason with empty tool_calls array', async () => {
  // Model says tool_calls but sends empty array — should fall through to stop handling
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'no tools called',
      finish_reason: 'tool_calls',
      tool_calls: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'no tools called')
})

test('loop emits turn/assistant/tool hooks for cli rendering', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())
  const events: string[] = []

  await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 10,
    onTurnStart: ({ turn }) => {
      events.push(`turn:${turn}`)
    },
    onAssistantResponse: ({ turn, finish_reason, tool_calls_count }) =>
      {
        events.push(`assistant:${turn}:${finish_reason}:${tool_calls_count}`)
      },
    onToolCallStart: ({ call }) => {
      events.push(`tool_start:${call.function.name}`)
    },
    onToolCallResult: ({ call }) => {
      events.push(`tool_done:${call.function.name}`)
    },
  })

  assert.equal(events.includes('turn:1'), true)
  assert.equal(events.includes('assistant:1:tool_calls:1'), true)
  assert.equal(events.includes('tool_start:echo_tool'), true)
  assert.equal(events.includes('tool_done:echo_tool'), true)
  assert.equal(events.includes('turn:2'), true)
  assert.equal(events.includes('assistant:2:stop:0'), true)
})

test('loop compacts oversized context once before provider call', async () => {
  const previous = process.env.MERLION_COMPACT_TRIGGER_CHARS
  process.env.MERLION_COMPACT_TRIGGER_CHARS = '300'
  process.env.MERLION_COMPACT_KEEP_RECENT = '4'

  try {
    const longHistory: ChatMessage[] = [
      { role: 'system', content: 'system' },
      ...Array.from({ length: 16 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `message-${i}-${'x'.repeat(120)}`,
      })),
    ]
    const provider = new StubProvider([
      {
        role: 'assistant',
        content: 'done',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const result = await runLoop({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'unused',
      userPrompt: 'go',
      cwd: process.cwd(),
      maxTurns: 5,
      initialMessages: longHistory,
      persistInitialMessages: false,
    })

    assert.equal(result.terminal, 'completed')
    assert.equal(result.state.hasAttemptedReactiveCompact, true)
    const summaryCount = result.state.messages.filter(
      (m) => typeof m.content === 'string' && m.content.includes('Conversation compact summary')
    ).length
    assert.equal(summaryCount, 1)
  } finally {
    if (previous === undefined) {
      delete process.env.MERLION_COMPACT_TRIGGER_CHARS
    } else {
      process.env.MERLION_COMPACT_TRIGGER_CHARS = previous
    }
    delete process.env.MERLION_COMPACT_KEEP_RECENT
  }
})

test('loop injects correction hint after repeated identical tool errors', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysFailTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: '/workspace/nanobot',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  const hintMessages = result.state.messages.filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Repeated tool failure detected')
  ))
  assert.equal(hintMessages.length, 1)
  assert.match(hintMessages[0]?.content ?? '', /always_fail/)
  assert.match(hintMessages[0]?.content ?? '', /workspace root/)
  assert.match(hintMessages[0]?.content ?? '', /\/workspace\/nanobot\/\.merlion/)
  assert.match(hintMessages[0]?.content ?? '', /Do not use `~\/\.merlion`/)
})

test('loop appends post-tool batch messages from callback', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 6,
    onToolBatchComplete: () => [
      {
        role: 'system',
        content: 'Path guidance update: narrowed to src/runtime'
      }
    ]
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(
    result.state.messages.some((m) => m.role === 'system' && (m.content ?? '').includes('Path guidance update')),
    true
  )
})
